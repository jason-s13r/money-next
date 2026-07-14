"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/server/db";
import { linkTransferLegs } from "@/lib/server/transfers";
import type { Prisma } from "@/lib/generated/prisma/client";

// Manual re-classification of a single transaction, and the reconciliation of the
// conflicts a later Akahu sync can raise against those edits.
//
// A hand-set field is marked `source: "user"` so `scripts/ingest.ts` stops
// overwriting it — instead the sync records a `TransactionConflict` when Akahu
// later reports a different, non-null value. See the schema notes on
// `Transaction.categorySource` and `TransactionConflict`.
//
// Both setters keep the denormalised name/group columns in step with the id.
// Those columns can eventually be dropped in favour of the transitive value from
// the joined Category/Merchant row (a schema change for another day); until then
// every reader still reads them, so they must not drift.

export async function setTransactionCategory(
  transactionId: string,
  categoryId: string | null,
) {
  if (categoryId === null) {
    await db.transaction.update({
      where: { id: transactionId },
      data: { categoryId: null, categoryName: null, categoryGroup: null, categorySource: "user" },
    });
  } else {
    const category = await db.category.findUnique({ where: { id: categoryId } });
    if (!category) throw new Error(`Unknown category: ${categoryId}`);
    await db.transaction.update({
      where: { id: transactionId },
      data: {
        categoryId: category.id,
        categoryName: category.name,
        categoryGroup: category.groupName,
        categorySource: "user",
      },
    });
  }

  // The user just made an authoritative choice for this field: any outstanding
  // conflict on it is settled.
  await db.transactionConflict.deleteMany({ where: { transactionId, field: "category" } });

  revalidatePath(`/transactions/${transactionId}`);
}

export async function setTransactionMerchant(
  transactionId: string,
  merchantId: string | null,
) {
  if (merchantId === null) {
    await db.transaction.update({
      where: { id: transactionId },
      data: { merchantId: null, merchantName: null, merchantSource: "user" },
    });
  } else {
    const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) throw new Error(`Unknown merchant: ${merchantId}`);
    await db.transaction.update({
      where: { id: transactionId },
      data: { merchantId: merchant.id, merchantName: merchant.name, merchantSource: "user" },
    });
  }

  await db.transactionConflict.deleteMany({ where: { transactionId, field: "merchant" } });

  revalidatePath(`/transactions/${transactionId}`);
}

/**
 * Create a brand-new merchant from the transaction details page and assign it to
 * the transaction. User-created merchants get a `user_...` id so they never
 * collide with Akahu's `merchant_...` ids, and the field is marked `user`-owned
 * so a later sync won't overwrite it.
 */
export async function createMerchantAndSetForTransaction(
  transactionId: string,
  name: string,
) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Merchant name is required");

  const merchant = await db.merchant.create({
    data: {
      id: `user_${randomUUID().replace(/-/g, "")}`,
      name: trimmed,
    },
  });

  await db.transaction.update({
    where: { id: transactionId },
    data: {
      merchantId: merchant.id,
      merchantName: merchant.name,
      merchantSource: "user",
    },
  });

  await db.transactionConflict.deleteMany({ where: { transactionId, field: "merchant" } });

  revalidatePath(`/transactions/${transactionId}`);
}

// Bulk versions of the two setters above, for applying this transaction's chosen
// category/merchant to the list of similar transactions on the same page. They
// mark the field `user`-owned (so the sync stops overwriting it, exactly like a
// hand-set single row) and settle any conflict outstanding on the touched rows.
// `sourceId` is the transaction whose page is open, so its view revalidates.

export async function applyCategoryToTransactions(
  sourceId: string,
  categoryId: string,
  transactionIds: string[],
) {
  if (transactionIds.length === 0) return;

  const category = await db.category.findUnique({ where: { id: categoryId } });
  if (!category) throw new Error(`Unknown category: ${categoryId}`);

  await db.transaction.updateMany({
    where: { id: { in: transactionIds } },
    data: {
      categoryId: category.id,
      categoryName: category.name,
      categoryGroup: category.groupName,
      categorySource: "user",
    },
  });

  await db.transactionConflict.deleteMany({
    where: { transactionId: { in: transactionIds }, field: "category" },
  });

  revalidatePath(`/transactions/${sourceId}`);
}

export async function applyMerchantToTransactions(
  sourceId: string,
  merchantId: string,
  transactionIds: string[],
) {
  if (transactionIds.length === 0) return;

  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw new Error(`Unknown merchant: ${merchantId}`);

  await db.transaction.updateMany({
    where: { id: { in: transactionIds } },
    data: { merchantId: merchant.id, merchantName: merchant.name, merchantSource: "user" },
  });

  await db.transactionConflict.deleteMany({
    where: { transactionId: { in: transactionIds }, field: "merchant" },
  });

  revalidatePath(`/transactions/${sourceId}`);
}

// Grouping transactions as the legs of one internal transfer, and ungrouping
// them. A `TransferGroup` holds two *or more* legs — an out/in pair, but also a
// currency conversion or a separate fee row — and every leg carries the group's id
// in `transferGroupId`, so "is this a transfer" stays a single `transferGroupId:
// null` test that the metrics and listings lean on. Akahu never says which rows
// belong together, so these groups are always user-made.

/**
 * Put `targetId` in the same transfer group as `sourceId`, creating the group if
 * neither is in one yet. If they are already in different groups the target's
 * whole group is merged into the source's, then the emptied group is removed —
 * so linking never leaves a transaction in two transfers at once.
 */
export async function linkTransfer(sourceId: string, targetId: string) {
  await linkTransferLegs(sourceId, targetId);

  revalidatePath(`/transactions/${sourceId}`);
  revalidatePath(`/transactions/${targetId}`);
}

// Text fields a transfer counterpart might be recognised by when the automatic
// candidates (see `getTransferCandidates`) can't find it — a cross-institution,
// cross-currency transfer whose legs share neither amount, timestamp, nor wording.
const TRANSFER_SEARCH_FIELDS = [
  "description",
  "merchantName",
  "reference",
  "particulars",
  "code",
  "otherAccount",
] as const;

/**
 * Free-text search over *ungrouped* transactions, to hand-pick a transfer leg the
 * heuristics miss. Excludes the source row and anything already in a transfer;
 * `contains` compiles to a case-insensitive `LIKE` on SQLite, as elsewhere.
 */
export async function searchTransferCandidates(sourceId: string, query: string) {
  const q = query.trim();
  if (q.length < 2) return [];
  return db.transaction.findMany({
    where: {
      id: { not: sourceId },
      transferGroupId: null,
      OR: TRANSFER_SEARCH_FIELDS.map((field) => ({ [field]: { contains: q } })),
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: 15,
    select: {
      id: true,
      date: true,
      amount: true,
      description: true,
      merchantName: true,
      account: { select: { name: true, currency: true } },
    },
  });
}

export type TransferSearchResult = Awaited<
  ReturnType<typeof searchTransferCandidates>
>[number];

/**
 * Take `transactionId` out of its transfer group. If that leaves the group with a
 * single leg it is no longer a transfer, so the last member is released too and
 * the empty group deleted.
 */
export async function unlinkTransfer(transactionId: string) {
  const tx = await db.transaction.findUnique({ where: { id: transactionId } });
  if (!tx || tx.transferGroupId == null) return;

  const groupId = tx.transferGroupId;
  const others = await db.transaction.findMany({
    where: { transferGroupId: groupId, id: { not: transactionId } },
    select: { id: true },
  });

  const writes: Prisma.PrismaPromise<unknown>[] = [
    db.transaction.update({ where: { id: transactionId }, data: { transferGroupId: null } }),
  ];
  // A one-leg "transfer" is meaningless: release the straggler and drop the group.
  if (others.length <= 1) {
    writes.push(
      db.transaction.updateMany({ where: { transferGroupId: groupId }, data: { transferGroupId: null } }),
      db.transferGroup.delete({ where: { id: groupId } }),
    );
  }
  await db.$transaction(writes);

  revalidatePath(`/transactions/${transactionId}`);
  for (const o of others) revalidatePath(`/transactions/${o.id}`);
}

/**
 * Keep the user's value and stop nagging about this divergence. The conflict is
 * marked `dismissed` rather than deleted so the next sync — which will re-observe
 * the same disagreement — leaves it settled instead of re-raising it. If Akahu
 * later moves to a *new* value, the sync re-opens it (see `reconcileConflict`).
 */
export async function keepUserValue(conflictId: number) {
  const conflict = await db.transactionConflict.findUnique({ where: { id: conflictId } });
  if (!conflict) return;

  await db.transactionConflict.update({
    where: { id: conflictId },
    data: { status: "dismissed" },
  });

  revalidatePath(`/transactions/${conflict.transactionId}`);
}

/**
 * Take Akahu's value, handing ownership of the field back to the sync. The
 * denormalised columns are refreshed from the catalog so name/group stay
 * consistent, `source` returns to `akahu`, and the conflict is cleared.
 */
export async function acceptAkahuValue(conflictId: number) {
  const conflict = await db.transactionConflict.findUnique({ where: { id: conflictId } });
  if (!conflict) return;

  const { transactionId, field, akahuValueId, akahuValueLabel } = conflict;

  if (field === "category") {
    const category = akahuValueId
      ? await db.category.findUnique({ where: { id: akahuValueId } })
      : null;
    await db.transaction.update({
      where: { id: transactionId },
      data: {
        categoryId: akahuValueId,
        categoryName: category?.name ?? akahuValueLabel,
        categoryGroup: category?.groupName ?? null,
        categorySource: "akahu",
      },
    });
  } else {
    const merchant = akahuValueId
      ? await db.merchant.findUnique({ where: { id: akahuValueId } })
      : null;
    await db.transaction.update({
      where: { id: transactionId },
      data: {
        merchantId: akahuValueId,
        merchantName: merchant?.name ?? akahuValueLabel,
        merchantSource: "akahu",
      },
    });
  }

  await db.transactionConflict.delete({ where: { id: conflictId } });

  revalidatePath(`/transactions/${transactionId}`);
}
