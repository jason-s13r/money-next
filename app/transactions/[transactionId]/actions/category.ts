"use server";

import { revalidatePath } from "next/cache";
import { recordUserChanges } from "@/lib/server/changes";
import { getDb } from "@/lib/server/db";

// Manual re-classification of a single transaction, and the reconciliation of the
// conflicts a later Akahu sync can raise against those edits.
//
// A hand-set field is marked `source: "user"` so `scripts/ingest.ts` stops
// overwriting it — instead the sync records a `TransactionConflict` when Akahu
// later reports a different, non-null value. See the schema notes on
// `Transaction.categorySource` and `TransactionConflict`.
//
// The merchant/category names now live only on the joined Merchant/Category rows;
// the transaction keeps just the ids. The category setter also keeps the
// denormalised `categoryGroupId` (a real group id) in step with the category, so
// the metrics that group by it stay correct.

export async function setTransactionCategory(
  transactionId: string,
  categoryId: string | null,
) {
  const db = await getDb();

  // Read before writing: the field change log needs what the field *was*, and
  // an update alone cannot say. This is the cost of the log on the interactive
  // path — one indexed lookup per edit — and it is why the log lives here rather
  // than in the scoped client, which sees the write but not the reason for it.
  const prior = await db.transaction.findUnique({
    where: { id: transactionId },
    select: { categoryId: true, category: { select: { name: true } } },
  });
  if (!prior) throw new Error(`Unknown transaction: ${transactionId}`);

  const category = categoryId
    ? await db.category.findUnique({ where: { id: categoryId } })
    : null;
  if (categoryId && !category) throw new Error(`Unknown category: ${categoryId}`);

  await db.transaction.update({
    where: { id: transactionId },
    data: {
      categoryId: category?.id ?? null,
      categoryGroupId: category?.groupId ?? null,
      categorySource: "user",
    },
  });

  // Log the change, not the click: re-picking the category a transaction already
  // has is a no-op, and a log that records it would drown the one that didn't.
  if (prior.categoryId !== (category?.id ?? null)) {
    await recordUserChanges(db, [
      {
        transactionId,
        field: "category",
        fromId: prior.categoryId,
        fromLabel: prior.category?.name ?? null,
        toId: category?.id ?? null,
        toLabel: category?.name ?? null,
      },
    ]);
  }

  // The user just made an authoritative choice for this field: any outstanding
  // conflict on it is settled.
  await db.transactionConflict.deleteMany({ where: { transactionId, field: "category" } });

  revalidatePath(`/transactions/${transactionId}`);
}

// Bulk version of the single setter, for applying this transaction's chosen
// category to the list of similar transactions on the same page. Marks the field
// `user`-owned and settles any conflict outstanding on the touched rows.
// `sourceId` is the transaction whose page is open, so its view revalidates.

export async function applyCategoryToTransactions(
  sourceId: string,
  categoryId: string,
  transactionIds: string[],
) {
  const db = await getDb();
  if (transactionIds.length === 0) return;

  const category = await db.category.findUnique({ where: { id: categoryId } });
  if (!category) throw new Error(`Unknown category: ${categoryId}`);

  // One read for the whole batch, not one per row: `updateMany` is a single
  // statement and the log should not turn it into N round trips. The scoped
  // client filters this, so ids from another workspace simply aren't returned —
  // and then aren't logged either, matching what `updateMany` will refuse to touch.
  const priors = await db.transaction.findMany({
    where: { id: { in: transactionIds } },
    select: { id: true, categoryId: true, category: { select: { name: true } } },
  });

  await db.transaction.updateMany({
    where: { id: { in: transactionIds } },
    data: {
      categoryId: category.id,
      categoryGroupId: category.groupId,
      categorySource: "user",
    },
  });

  await recordUserChanges(
    db,
    priors
      .filter((prior) => prior.categoryId !== category.id)
      .map((prior) => ({
        transactionId: prior.id,
        field: "category" as const,
        fromId: prior.categoryId,
        fromLabel: prior.category?.name ?? null,
        toId: category.id,
        toLabel: category.name,
      })),
  );

  await db.transactionConflict.deleteMany({
    where: { transactionId: { in: transactionIds }, field: "category" },
  });

  revalidatePath(`/transactions/${sourceId}`);
}
