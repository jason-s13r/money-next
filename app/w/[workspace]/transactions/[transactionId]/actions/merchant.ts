"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { mintId } from "@/lib/ids";
import { recordUserChanges } from "@/lib/server/changes";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";

/** What the field change log needs to know before an edit overwrites it. */
async function priorMerchant(db: Awaited<ReturnType<typeof getDb>>, transactionId: string) {
  const prior = await db.transaction.findUnique({
    where: { id: transactionId },
    select: { merchantId: true, merchant: { select: { name: true } } },
  });
  if (!prior) throw new Error(`Unknown transaction: ${transactionId}`);
  return prior;
}

export async function setTransactionMerchant(
  transactionId: string,
  merchantId: string | null,
) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  const prior = await priorMerchant(db, transactionId);

  const merchant = merchantId
    ? await db.merchant.findUnique({ where: { id: merchantId } })
    : null;
  if (merchantId && !merchant) throw new Error(`Unknown merchant: ${merchantId}`);

  await db.transaction.update({
    where: { id: transactionId },
    data: { merchantId: merchant?.id ?? null, merchantSource: "user" },
  });

  if (prior.merchantId !== (merchant?.id ?? null)) {
    await recordUserChanges(db, [
      {
        transactionId,
        field: "merchant",
        fromId: prior.merchantId,
        fromLabel: prior.merchant?.name ?? null,
        toId: merchant?.id ?? null,
        toLabel: merchant?.name ?? null,
      },
    ]);
  }

  await db.transactionConflict.deleteMany({ where: { transactionId, field: "merchant" } });

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

  const prior = await priorMerchant(db, transactionId);

  const merchant = await db.merchant.create({
    data: {
      id: mintId("merchant"),
      workspaceId: db.$workspaceId,
      name: trimmed,
    },
  });

  await db.transaction.update({
    where: { id: transactionId },
    data: {
      merchantId: merchant.id,
      merchantSource: "user",
    },
  });

  // Always a change: the merchant was minted a line ago, so nothing can already
  // have it.
  await recordUserChanges(db, [
    {
      transactionId,
      field: "merchant",
      fromId: prior.merchantId,
      fromLabel: prior.merchant?.name ?? null,
      toId: merchant.id,
      toLabel: merchant.name,
    },
  ]);

  await db.transactionConflict.deleteMany({ where: { transactionId, field: "merchant" } });

  await revalidateWorkspacePath(`/transactions/${transactionId}`);
}

// Bulk version of the single setter, for applying this transaction's chosen
// merchant to the list of similar transactions on the same page.

export async function applyMerchantToTransactions(
  sourceId: string,
  merchantId: string,
  transactionIds: string[],
) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  if (transactionIds.length === 0) return;

  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw new Error(`Unknown merchant: ${merchantId}`);

  // One read for the whole batch — see the note in the category equivalent.
  const priors = await db.transaction.findMany({
    where: { id: { in: transactionIds } },
    select: { id: true, merchantId: true, merchant: { select: { name: true } } },
  });

  await db.transaction.updateMany({
    where: { id: { in: transactionIds } },
    data: { merchantId: merchant.id, merchantSource: "user" },
  });

  await recordUserChanges(
    db,
    priors
      .filter((prior) => prior.merchantId !== merchant.id)
      .map((prior) => ({
        transactionId: prior.id,
        field: "merchant" as const,
        fromId: prior.merchantId,
        fromLabel: prior.merchant?.name ?? null,
        toId: merchant.id,
        toLabel: merchant.name,
      })),
  );

  await db.transactionConflict.deleteMany({
    where: { transactionId: { in: transactionIds }, field: "merchant" },
  });

  await revalidateWorkspacePath(`/transactions/${sourceId}`);
}
