import "server-only";
import { connection } from "next/server";
import { getDb } from "../db/request";
import { convert, loadRates } from "../currency";
import { pendingMoney } from "../money";
import type { Prisma } from "../../generated/prisma/client";
import { DISPLAY_CURRENCY } from "./transactions";

// Pending (authorised but unsettled) transaction listings. Pending rows carry far
// less than settled ones — Akahu attaches only `meta`, no merchant/category — so
// they get a lighter enrichment than `enrichTransactions`: just their value in the
// display currency. The set is small and transient (a full snapshot replaced on
// each sync, see `syncPendingTransactions`) and shown only atop a listing's first
// page. Valued in the same `DISPLAY_CURRENCY` as the settled listings.

// The relations a listed *pending* row carries. Pending transactions aren't
// enriched with a merchant/category (Akahu attaches only `meta`), so a pending
// row needs far less than a settled one — just enough to name its account and
// value it in the display currency.
const pendingListInclude = {
  account: { select: { id: true, name: true, currency: true, connection: { select: { logo: true } } } },
} satisfies Prisma.PendingTransactionInclude;

/**
 * Attach each pending row's value in `DISPLAY_CURRENCY` so a foreign-currency hold
 * is comparable to the rest, mirroring `enrichTransactions` but without the
 * transfer/conflict/merchant work pending rows have no data for.
 */
async function enrichPending<
  T extends { amount: number; account: { currency: string | null } },
>(items: T[]) {
  const rates = await loadRates([...items.map((i) => i.account.currency), DISPLAY_CURRENCY]);
  return items.map((i) => ({
    ...i,
    amountBase: convert(i.amount, i.account.currency, DISPLAY_CURRENCY, rates),
  }));
}

export type PendingTransactionItem = Awaited<
  ReturnType<typeof getPendingTransactions>
>[number];

/**
 * Every pending (authorised but unsettled) transaction, newest first. Unpaginated
 * — the set is small and transient (a full snapshot replaced on each sync, see
 * `syncPendingTransactions`) — and shown only atop the first page of a listing.
 */
export async function getPendingTransactions() {
  await connection();
  const db = await getDb();
  const rows = await db.pendingTransaction.findMany({
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: pendingListInclude,
  });
  return enrichPending(rows.map(pendingMoney));
}

/** The pending transactions for one account, newest first. */
export async function getAccountPendingTransactions(accountId: string) {
  await connection();
  const db = await getDb();
  const rows = await db.pendingTransaction.findMany({
    where: { accountId },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: pendingListInclude,
  });
  return enrichPending(rows.map(pendingMoney));
}
