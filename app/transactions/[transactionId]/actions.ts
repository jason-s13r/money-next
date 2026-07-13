"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";

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
