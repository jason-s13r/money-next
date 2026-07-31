"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { mintId } from "@/lib/ids";
import { applyEnrichment } from "@/lib/server/enrichment";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";

// Naming a transaction's payee by hand, and applying that name to the rows on the
// page that look like it. The write is `applyEnrichment` — see the note in the
// category action for what it does and why its steps have to commit together.

export async function setTransactionMerchant(
  transactionId: string,
  merchantId: string | null,
) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  const written = await applyEnrichment(db, "merchant", [transactionId], merchantId);
  if (written === 0) throw new Error(`Unknown transaction: ${transactionId}`);

  await revalidateWorkspacePath(`/transactions/${transactionId}`);
}

/**
 * Create a brand-new merchant from the transaction details page and assign it to
 * the transaction. The id is minted under this instance's namespace (see
 * `mintId`) so it can never collide with — or be mistaken for — one of Akahu's
 * `merchant_...` catalog entries, and the field is marked `user`-owned so a later
 * sync won't overwrite it.
 *
 * The workspace is what actually makes this merchant private (`workspaceId` set
 * rather than null, see `scopedDb`); the id only says so to whoever reads it.
 */
export async function createMerchantAndSetForTransaction(
  transactionId: string,
  name: string,
) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Merchant name is required");

  const merchant = await db.merchant.create({
    data: { id: mintId("merchant"), workspaceId: db.$workspaceId, name: trimmed },
    select: { id: true },
  });

  // Assigned through the shared path like any other pick, which costs one indexed
  // re-read of the row minted a line above. Worth it: the version that skipped the
  // read also had to skip the diff ("always a change, nothing can already have
  // it") and so was a second way of writing this field, correct only as long as
  // nobody changed the first one.
  const written = await applyEnrichment(db, "merchant", [transactionId], merchant.id);
  if (written === 0) throw new Error(`Unknown transaction: ${transactionId}`);

  await revalidateWorkspacePath(`/transactions/${transactionId}`);
}

/**
 * Apply this transaction's chosen merchant to the list of similar transactions
 * shown alongside it. `sourceId` is the transaction whose page is open, so its
 * view is the one that revalidates.
 */
export async function applyMerchantToTransactions(
  sourceId: string,
  merchantId: string,
  transactionIds: string[],
) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  await applyEnrichment(db, "merchant", transactionIds, merchantId);

  await revalidateWorkspacePath(`/transactions/${sourceId}`);
}
