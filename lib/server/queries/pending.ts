import "server-only";
import { connection } from "next/server";
import { getDb } from "../db/request";
import { convert, loadRates } from "../currency";
import { pendingMoney } from "../money";
import { dismissalFor } from "../pending-dismissal";
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
  account: {
    select: {
      id: true,
      name: true,
      displayName: true,
      currency: true,
      connection: { select: { logo: true } },
    },
  },
} satisfies Prisma.PendingTransactionInclude;

/**
 * A fetched pending row with its money columns already out of Prisma's `Decimal`
 * — what `pendingMoney` hands back, and what the enrichment below takes.
 */
type PendingRow = Omit<
  Prisma.PendingTransactionGetPayload<{ include: typeof pendingListInclude }>,
  "amount" | "conversionAmount"
> & { amount: number; conversionAmount: number | null };

/**
 * Attach each pending row's value in `DISPLAY_CURRENCY` so a foreign-currency hold
 * is comparable to the rest, mirroring `enrichTransactions` but without the
 * transfer/conflict/merchant work pending rows have no data for.
 */
async function enrichPending(items: PendingRow[]) {
  const rates = await loadRates([...items.map((i) => i.account.currency), DISPLAY_CURRENCY]);
  return items.map((i) => ({
    ...i,
    amountBase: convert(i.amount, i.account.currency, DISPLAY_CURRENCY, rates),
  }));
}

export type PendingTransactionItem = Awaited<ReturnType<typeof enrichPending>>[number];

/**
 * A hidden hold, carrying the id of the rule hiding it — so the listing can group
 * what it is holding back under the thing to undo, rather than re-deriving the
 * match in the browser.
 */
export type DismissedPendingItem = PendingTransactionItem & { dismissedBy: string };

/** A dismissal as the listing shows it: its words, and the bank it applies to. */
export type DismissalView = {
  id: string;
  tokens: string[];
  connectionId: string;
  connectionName: string;
};

/**
 * A listing's pending block: what to show, and what a dismissal is holding back.
 *
 * The hidden rows travel with the visible ones rather than being dropped in SQL,
 * because a rule the person cannot see is one they cannot undo — and these rows
 * *are* the only place a dismissal appears. The set is tiny and unpaginated, so
 * carrying it costs nothing.
 */
export type PendingList = {
  items: PendingTransactionItem[];
  dismissed: DismissedPendingItem[];
  /** Only the rules actually hiding something here, newest first. */
  rules: DismissalView[];
};

/** Split a fetched page of holds into shown and hidden, per the workspace's rules. */
async function withDismissals(rows: PendingTransactionItem[]): Promise<PendingList> {
  const db = await getDb();
  const stored = await db.pendingDismissal.findMany({
    orderBy: { createdAt: "desc" },
    include: { connection: { select: { name: true } } },
  });

  const items: PendingTransactionItem[] = [];
  const dismissed: DismissedPendingItem[] = [];
  const hiding = new Map<string, DismissalView>();
  for (const row of rows) {
    const rule = dismissalFor(row, stored);
    if (!rule) {
      items.push(row);
      continue;
    }
    dismissed.push({ ...row, dismissedBy: rule.id });
    hiding.set(rule.id, {
      id: rule.id,
      tokens: rule.tokens,
      connectionId: rule.connectionId,
      connectionName: rule.connection.name,
    });
  }

  // Ordered by the rules query, not by encounter: the newest dismissal is the one
  // the person just made, and it belongs at the top of what they are undoing.
  return { items, dismissed, rules: stored.flatMap((r) => hiding.get(r.id) ?? []) };
}

/**
 * Every pending (authorised but unsettled) transaction, newest first. Unpaginated
 * — the set is small and transient (a full snapshot replaced on each sync, see
 * `syncPendingTransactions`) — and shown only atop the first page of a listing.
 */
export async function getPendingTransactions(): Promise<PendingList> {
  await connection();
  const db = await getDb();
  const rows = await db.pendingTransaction.findMany({
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: pendingListInclude,
  });
  return withDismissals(await enrichPending(rows.map(pendingMoney)));
}

/** The pending transactions for one account, newest first. */
export async function getAccountPendingTransactions(accountId: string): Promise<PendingList> {
  await connection();
  const db = await getDb();
  const rows = await db.pendingTransaction.findMany({
    where: { accountId },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: pendingListInclude,
  });
  return withDismissals(await enrichPending(rows.map(pendingMoney)));
}
