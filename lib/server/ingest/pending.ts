import type {
  Account as AkahuAccount,
  PendingTransaction as AkahuPendingTransaction,
} from "akahu";
import { db } from "../db";
import type { Prisma } from "../../generated/prisma/client";

/** Pending rows are enriched only with `meta` (no merchant/category). */
function isEnrichedPending(
  tx: AkahuPendingTransaction,
): tx is Extract<AkahuPendingTransaction, { meta: unknown }> {
  return "meta" in tx;
}

/**
 * Mirror Akahu's *pending* (authorised but unsettled) transactions. Unlike the
 * settled ledger these have no stable id and are transient — a pending row
 * vanishes once it settles or cancels — so this is a full snapshot replace, not
 * an incremental upsert: the table is emptied and rewritten with whatever Akahu
 * currently reports. The list is small and unpaginated (one request, no cursor).
 *
 * Best-effort like the category/FX steps: a failure warns and leaves the existing
 * rows untouched rather than failing the whole sync — and because the delete only
 * runs after a successful fetch, a transient error never wipes good data. Pending
 * rows never enter any balance, spend or rules path; they are display-only.
 */
export async function syncPendingTransactions(accounts: AkahuAccount[]): Promise<void> {
  try {
    const knownAccountIds = new Set(accounts.map((a) => a._id));
    const { akahuClient, akahuUserToken } = await import("../akahu");
    const akahu = akahuClient();
    const pending = await akahu.transactions.listPending(akahuUserToken());

    const rows: Prisma.PendingTransactionCreateManyInput[] = [];
    for (const tx of pending) {
      // A pending row for an account we don't store would violate the FK; drop it.
      if (!knownAccountIds.has(tx._account)) continue;

      const enriched = isEnrichedPending(tx) ? tx : undefined;
      const conversion = enriched?.meta?.conversion;
      rows.push({
        accountId: tx._account,
        connectionId: tx._connection,
        date: new Date(tx.date),
        description: tx.description,
        amount: tx.amount,
        type: tx.type,
        akahuUpdatedAt: new Date(tx.updated_at),
        particulars: enriched?.meta?.particulars ?? null,
        code: enriched?.meta?.code ?? null,
        reference: enriched?.meta?.reference ?? null,
        otherAccount: enriched?.meta?.other_account ?? null,
        cardSuffix: enriched?.meta?.card_suffix ?? null,
        conversionAmount: conversion?.amount ?? null,
        conversionCurrency: conversion?.currency ?? null,
        conversionRate: conversion?.rate ?? null,
      });
    }

    // Replace the whole set in one write transaction: the table always equals
    // Akahu's current pending, and a crash can't leave a half-applied snapshot.
    await db.$transaction([
      db.pendingTransaction.deleteMany({}),
      ...(rows.length > 0 ? [db.pendingTransaction.createMany({ data: rows })] : []),
    ]);

    console.log(`pending:      ${rows.length} synced`);
  } catch (error) {
    console.warn(`pending:      skipped — ${error instanceof Error ? error.message : String(error)}`);
  }
}
