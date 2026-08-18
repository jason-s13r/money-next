"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { applyEnrichment } from "@/lib/server/enrichment";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";

// Manual re-classification of a single transaction, and of the rows on the page
// that look like it.
//
// A hand-set field is marked `source: "user"` so the ingest pipeline stops
// overwriting it — instead the sync records a `TransactionConflict` when Akahu
// later reports a different, non-null value. See the schema notes on
// `Transaction.categorySource` and `TransactionConflict`.
//
// The write itself — read what the field was, set the new value, log the rows
// that actually changed, settle any conflict on the field, all in one
// transaction — is `applyEnrichment`, shared with the merchant setter and the
// listing's bulk bar. What stays here is what genuinely differs between them: who
// may do it, and which pages have to re-render afterwards. The denormalised
// `categoryGroupId` is kept in step with the category down there, so the metrics
// that group by it stay correct.

export async function setTransactionCategory(
  transactionId: string,
  categoryId: string | null,
) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  // A single-row setter handed an id this workspace cannot see has been handed a
  // bad id — say so, rather than reporting a success that wrote nothing.
  const written = await applyEnrichment(db, "category", [transactionId], categoryId);
  if (written === 0) throw new Error(`Unknown transaction: ${transactionId}`);

  await revalidateWorkspacePath(`/transactions/${transactionId}`);
}

/**
 * Apply this transaction's chosen category to the list of similar transactions
 * shown alongside it. `sourceId` is the transaction whose page is open, so its
 * view is the one that revalidates.
 */
export async function applyCategoryToTransactions(
  sourceId: string,
  categoryId: string,
  transactionIds: string[],
) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  await applyEnrichment(db, "category", transactionIds, categoryId);

  await revalidateWorkspacePath(`/transactions/${sourceId}`);
}
