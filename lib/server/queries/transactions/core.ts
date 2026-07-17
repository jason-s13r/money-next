import "server-only";
import { connection } from "next/server";
import { getDb } from "../../db";
import { convert, FALLBACK_DISPLAY_CURRENCY, loadRates } from "../../currency";
import { moneySum, transactionMoney } from "../../money";
import type { Prisma } from "../../../generated/prisma/client";
import { DEFAULT_SORT, type Sort } from "@/lib/transactions/sort";

// The shared machinery every "what is in this bucket?" listing renders through:
// the relations a row carries, the batched enrichment/totalling pass, and the
// `listTransactions` core that the account/category/merchant/card/type/search
// pages all call. The listing functions themselves live in `index.ts`.
//
// The dashboard reads only from the database. Nothing here calls Akahu — that
// happens out-of-band in scripts/ingest.ts, so page loads never wait on a bank
// refresh.
//
// Every query awaits `connection()` first, so that a query can't resolve during
// prerendering and bake the dashboard into static HTML at build time —
// permanently showing whatever balances existed when it was built.
//
// This is also the layer that converts money out of Prisma's `Decimal` (see
// lib/server/money.ts): rows leave here with plain numbers, so nothing above has
// to know how money is stored.

export const TRANSACTIONS_PER_PAGE = 50;

// The one currency every listing's amounts are compared and totalled in. Accounts
// are held in AUD/CHF/EUR/USD as well as NZD, so a raw column of mixed-currency
// amounts (and a raw sum of them) would be nonsense; each row also carries its
// value here, and the header totals in it. Fixed (unlike the dashboard's dynamic
// display currency) so a listing's column reads in one steady unit. Conversion
// itself lives in `lib/currency.ts`; a listing values every row at its currency's
// latest rate, so it loads rates with no date (see `loadRates`). Exported so the
// pending listings value their rows in the same unit.
export const DISPLAY_CURRENCY = FALLBACK_DISPLAY_CURRENCY;

// The relations every listing row carries beyond its own columns, so a page keyed
// by account, category, merchant, card, or type all render through the shared
// `TransactionTable`. `satisfies` keeps the literal shape so Prisma still infers
// each row's type. The `account` relation is redundant on a single-account page
// (the column is hidden there) but keeps one row type across every listing.
export const listInclude = {
  account: { select: { id: true, name: true, currency: true, connection: { select: { logo: true } } } },
  merchant: { select: { name: true, logo: true } },
  category: { select: { name: true } },
  categoryGroup: { select: { id: true, name: true } },
} satisfies Prisma.TransactionInclude;

/** A short human summary of the transfer a listed row is one leg of. */
export type TransferSummary = { label: string };

/**
 * Attaches to each listed row the three things the shared table shows beyond the
 * row's own columns, in one batched pass over a whole page:
 *
 * - `transfer` — for a row that's a leg of a linked transfer (see
 *   `Transaction.transferGroupId`), a summary naming the money's other side
 *   ("Transfer to Savings"), derived from the group's *other* legs and the row's
 *   own sign; `null` for an ungrouped row.
 * - `needsReview` — whether the row has an open enrichment conflict awaiting the
 *   user (see `TransactionConflict`), so it can be flagged in place.
 * - `amountBase` — the row's amount in `DISPLAY_CURRENCY`, so a foreign-currency
 *   row is comparable to the rest; `null` when no rate covers its currency.
 */
export async function enrichTransactions<
  T extends {
    id: string;
    amount: number;
    accountId: string;
    transferGroupId: string | null;
    account: { currency: string | null };
  },
>(items: T[]) {
  const db = await getDb();
  const groupIds = [
    ...new Set(items.map((i) => i.transferGroupId).filter((id): id is string => id != null)),
  ];

  const [legs, openConflicts, rates] = await Promise.all([
    groupIds.length > 0
      ? db.transaction.findMany({
          where: { transferGroupId: { in: groupIds } },
          select: { transferGroupId: true, accountId: true, account: { select: { name: true } } },
        })
      : Promise.resolve([]),
    db.transactionConflict.findMany({
      where: { status: "open", transactionId: { in: items.map((i) => i.id) } },
      select: { transactionId: true },
    }),
    loadRates([...items.map((i) => i.account.currency), DISPLAY_CURRENCY]),
  ]);

  const byGroup = new Map<string, typeof legs>();
  for (const leg of legs) {
    const group = byGroup.get(leg.transferGroupId!) ?? [];
    group.push(leg);
    byGroup.set(leg.transferGroupId!, group);
  }
  const needsReview = new Set(openConflicts.map((c) => c.transactionId));

  return items.map((i) => {
    let transfer: TransferSummary | null = null;
    if (i.transferGroupId != null) {
      // The money's other side: distinct accounts among the group's other legs.
      const counterparts = [
        ...new Set(
          (byGroup.get(i.transferGroupId) ?? [])
            .filter((l) => l.accountId !== i.accountId)
            .map((l) => l.account.name),
        ),
      ].join(", ");
      const label = !counterparts
        ? "Transfer"
        : i.amount < 0
          ? `Transfer to ${counterparts}`
          : `Transfer from ${counterparts}`;
      transfer = { label };
    }
    return {
      ...i,
      transfer,
      needsReview: needsReview.has(i.id),
      amountBase: convert(i.amount, i.account.currency, DISPLAY_CURRENCY, rates),
    };
  });
}

/**
 * The net of every row matching `where`, in `DISPLAY_CURRENCY`. Summed per account
 * (a cheap group-by) and each subtotal converted at its currency's latest rate,
 * rather than a single SQL sum — which would add NZD, USD and CHF as if they were
 * one number. Falls back to a subtotal's raw amount when no rate covers it.
 */
export async function netInDisplay(where: Prisma.TransactionWhereInput): Promise<number> {
  const db = await getDb();
  const byAccount = await db.transaction.groupBy({
    by: ["accountId"],
    where,
    _sum: { amount: true },
  });
  if (byAccount.length === 0) return 0;

  const accounts = await db.account.findMany({
    where: { id: { in: byAccount.map((b) => b.accountId) } },
    select: { id: true, currency: true },
  });
  const currencyById = new Map(accounts.map((a) => [a.id, a.currency]));
  const rates = await loadRates([...accounts.map((a) => a.currency), DISPLAY_CURRENCY]);

  let net = 0;
  for (const b of byAccount) {
    // Summed exactly by Postgres, then converted to a number here: the FX
    // conversion below is float arithmetic either way.
    const raw = moneySum(b._sum.amount);
    net += convert(raw, currencyById.get(b.accountId) ?? null, DISPLAY_CURRENCY, rates) ?? raw;
  }
  return net;
}

/**
 * A column sort turned into Prisma's `orderBy`. Institutions report most
 * transactions with a midday timestamp rather than a real time, so many rows tie
 * on `date` (and other columns tie freely); `id` always breaks the tie so a row
 * never lands on two pages. `amount` here is the raw signed value — the magnitude
 * ordering the uncategorised queue wants is handled in
 * `getUncategorisedTransactions`, which Prisma can't express as an `orderBy`.
 */
function orderByForSort(sort: Sort): Prisma.TransactionOrderByWithRelationInput[] {
  const { dir } = sort;
  const tiebreak = { id: "desc" } as const;
  switch (sort.field) {
    case "description":
      return [{ description: dir }, tiebreak];
    case "account":
      return [{ account: { name: dir } }, tiebreak];
    case "category":
      return [{ category: { name: dir } }, tiebreak];
    case "card":
      return [{ cardSuffix: dir }, tiebreak];
    case "type":
      return [{ type: dir }, tiebreak];
    case "amount":
      return [{ amount: dir }, tiebreak];
    case "balance":
      return [{ balance: dir }, tiebreak];
    case "date":
    default:
      return [{ date: dir }, tiebreak];
  }
}

/**
 * One page of an arbitrary slice of transactions, newest first, plus the whole
 * slice's row count and net amount — the header needs the totals for *all* rows,
 * not just the fifty on screen.
 *
 * A listing shows every row matching its filter key, including transfers (both the
 * type Akahu tags and hand-linked groups): a page keyed by account, category, or
 * merchant that hid some of its rows would misstate what that key contains, and
 * the count/net here already aggregate over all of them.
 */
export async function listTransactions(
  where: Prisma.TransactionWhereInput,
  page: number,
  sort: Sort = DEFAULT_SORT,
  perPage = TRANSACTIONS_PER_PAGE,
) {
  await connection();
  const db = await getDb();
  const [rows, total, net] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: orderByForSort(sort),
      skip: (page - 1) * perPage,
      take: perPage,
      include: listInclude,
    }),
    db.transaction.count({ where }),
    netInDisplay(where),
  ]);

  return { items: await enrichTransactions(rows.map(transactionMoney)), total, net };
}

export type TransactionListItem = Awaited<ReturnType<typeof listTransactions>>["items"][number];
