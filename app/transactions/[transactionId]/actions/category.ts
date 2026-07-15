"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/server/db";

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
  if (categoryId === null) {
    await db.transaction.update({
      where: { id: transactionId },
      data: { categoryId: null, categoryGroupId: null, categorySource: "user" },
    });
  } else {
    const category = await db.category.findUnique({ where: { id: categoryId } });
    if (!category) throw new Error(`Unknown category: ${categoryId}`);
    await db.transaction.update({
      where: { id: transactionId },
      data: {
        categoryId: category.id,
        categoryGroupId: category.groupId,
        categorySource: "user",
      },
    });
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
  if (transactionIds.length === 0) return;

  const category = await db.category.findUnique({ where: { id: categoryId } });
  if (!category) throw new Error(`Unknown category: ${categoryId}`);

  await db.transaction.updateMany({
    where: { id: { in: transactionIds } },
    data: {
      categoryId: category.id,
      categoryGroupId: category.groupId,
      categorySource: "user",
    },
  });

  await db.transactionConflict.deleteMany({
    where: { transactionId: { in: transactionIds }, field: "category" },
  });

  revalidatePath(`/transactions/${sourceId}`);
}
