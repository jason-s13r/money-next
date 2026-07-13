import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { db } from "./db";
import type { Prisma } from "./generated/prisma/client";

// The dashboard reads only from SQLite. Nothing here calls Akahu — that happens
// out-of-band in scripts/ingest.ts, so page loads never wait on a bank refresh.
//
// Every query awaits `connection()` first. better-sqlite3 is synchronous, so
// without it these queries resolve during prerendering and the dashboard is
// baked into static HTML at build time — permanently showing whatever balances
// existed when it was built.

export async function getAccounts() {
  await connection();
  return db.account.findMany({
    orderBy: [{ status: "asc" }, { connectionName: "asc" }, { name: "asc" }],
  });
}

export async function getRecentTransactions(limit = 50) {
  await connection();
  return db.transaction.findMany({
    orderBy: { date: "desc" },
    take: limit,
    include: { account: { select: { name: true } } },
  });
}

// `generateMetadata` and the page component both need the record. Prisma isn't
// `fetch`, so it gets no automatic request memoization — `cache` supplies it and
// the second caller reuses the first query.
export const getAccount = cache(async (id: string) => {
  await connection();
  return db.account.findUnique({ where: { id } });
});

export const TRANSACTIONS_PER_PAGE = 50;

/**
 * One page of an account's transactions, newest first, with the total row count
 * so the caller can render page numbers.
 *
 * Offset pagination is fine at this scale (thousands of rows, local SQLite) and
 * gives addressable `?page=N` urls. Institutions report most transactions with a
 * midday timestamp rather than a real time, so thousands of rows tie on `date`
 * alone; `id` breaks the tie and keeps a row from appearing on two pages.
 */
export async function getAccountTransactions(
  accountId: string,
  page: number,
  perPage = TRANSACTIONS_PER_PAGE,
) {
  await connection();
  const [items, total] = await Promise.all([
    db.transaction.findMany({
      where: { accountId },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      skip: (page - 1) * perPage,
      take: perPage,
      include: { merchant: { select: { name: true } } },
    }),
    db.transaction.count({ where: { accountId } }),
  ]);

  return { items, total };
}

/**
 * One page of an arbitrary slice of transactions, newest first, plus the whole
 * slice's row count and net amount — the header needs the totals for *all* rows,
 * not just the fifty on screen.
 */
async function listTransactions(
  where: Prisma.TransactionWhereInput,
  page: number,
  perPage = TRANSACTIONS_PER_PAGE,
) {
  await connection();
  const [items, total, aggregate] = await Promise.all([
    db.transaction.findMany({
      where: {
        ...where,
        'type': { 'notIn': ['TRANSFER']},
      },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        account: { select: { id: true, name: true, currency: true } },
        merchant: { select: { name: true } },
      },
    }),
    db.transaction.count({ where }),
    db.transaction.aggregate({ where, _sum: { amount: true } }),
  ]);

  return { items, total, net: aggregate._sum.amount ?? 0 };
}

export type TransactionListItem = Awaited<ReturnType<typeof listTransactions>>["items"][number];

/**
 * Spending, and only spending: money out is any transaction with a negative
 * amount. Categorised spending additionally carries an Akahu `categoryGroup`;
 * income (money in) is excluded here by the sign alone.
 */
const SPENDING: Prisma.TransactionWhereInput = { amount: { lt: 0 } };

export function getGroupTransactions(group: string, page: number) {
  return listTransactions({ categoryGroup: group }, page);
}

export function getCategoryTransactions(group: string, category: string, page: number) {
  return listTransactions({ categoryGroup: group, categoryName: category }, page);
}

// Every text field a reader might recognise a transaction by: the raw bank
// description, the enriched merchant/category names, and the
// particulars/code/reference/counterparty fields a bank splits a payment across.
// `contains` on SQLite compiles to `LIKE`, which is case-insensitive for ASCII —
// Prisma's `mode: "insensitive"` isn't supported on this provider and isn't
// needed for it.
const searchableFields = [
  "description",
  "merchantName",
  "categoryName",
  "particulars",
  "code",
  "reference",
  "otherAccount",
] as const;

/**
 * Transactions whose text matches a free-text query, newest first, with the
 * whole result set's count and net amount for the header.
 *
 * Unlike the category and merchant listings this does *not* hide transfers: a
 * search for an account number or a payment reference should surface the
 * transfer that carries it, which is often the whole point of searching.
 */
export async function searchTransactions(query: string, page: number, perPage = TRANSACTIONS_PER_PAGE) {
  await connection();
  const where: Prisma.TransactionWhereInput = {
    OR: searchableFields.map((field) => ({ [field]: { contains: query } })),
  };
  const [items, total, aggregate] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: [{ date: "desc" }, { id: "desc" }],
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        account: { select: { id: true, name: true, currency: true } },
        merchant: { select: { name: true } },
      },
    }),
    db.transaction.count({ where }),
    db.transaction.aggregate({ where, _sum: { amount: true } }),
  ]);

  return { items, total, net: aggregate._sum.amount ?? 0 };
}

/**
 * Money in: every inflow, defined by sign rather than group so it stays correct
 * whatever income group (Periodic/Other) a row does or doesn't yet carry.
 */
export function getIncomeTransactions(page: number) {
  return listTransactions({ amount: { gt: 0 } }, page);
}

/**
 * Transactions no rule could name, in either direction. The same rows the
 * dashboard greys out — the sign filter is deliberately absent so an
 * uncategorised inflow shows here rather than being silently dropped.
 */
export function getUncategorisedTransactions(page: number) {
  return listTransactions({ categoryId: null }, page);
}

/**
 * Everything paid to (or refunded by) a merchant, in every direction — a
 * merchant page that hid the refunds would misstate what the merchant cost.
 */
export function getMerchantTransactions(merchant: string, page: number) {
  // Matched on the linked merchant's name, not an id: one business can hold more
  // than one merchant id, and this page is keyed by the name the reader sees.
  return listTransactions({ merchant: { is: { name: merchant } } }, page);
}

/**
 * Everything charged to a card, in every direction.
 *
 * A suffix is the last digits of a card number, not a key: the same card can be
 * attached to two accounts, and two cards from different banks could in principle
 * end in the same four digits. This lists whatever carries the suffix, which is
 * what the reader clicked, and shows the account on every row.
 */
export function getCardTransactions(suffix: string, page: number) {
  return listTransactions({ cardSuffix: suffix }, page);
}

/** The card suffixes on record, so an unknown one 404s instead of listing nothing. */
export const getCardSuffixes = cache(async () => {
  await connection();
  const rows = await db.transaction.findMany({
    where: { cardSuffix: { not: null } },
    distinct: ["cardSuffix"],
    select: { cardSuffix: true },
  });
  return rows.map((row) => row.cardSuffix!);
});

/** The category names a group actually holds, for resolving a slug back. */
export const getCategoryNames = cache(async (group: string) => {
  await connection();
  const rows = await db.transaction.findMany({
    where: { categoryGroup: group, categoryName: { not: null } },
    distinct: ["categoryName"],
    select: { categoryName: true },
  });
  return rows.map((row) => row.categoryName!);
});

/** Every merchant name on record, for resolving a slug back. */
export const getMerchantNames = cache(async () => {
  await connection();
  const rows = await db.transaction.findMany({
    where: { merchantName: { not: null } },
    distinct: ["merchantName"],
    select: { merchantName: true },
  });
  return rows.map((row) => row.merchantName!);
});

/**
 * The whole NZFCC catalog, for the category picker on a transaction. Ordered by
 * group then name so the dropdown can show categories under their spending group.
 */
export const getCategories = cache(async () => {
  await connection();
  return db.category.findMany({
    orderBy: [{ groupName: "asc" }, { name: "asc" }],
    select: { id: true, name: true, groupName: true, direction: true },
  });
});

/** Every merchant on record, for the merchant picker on a transaction. */
export const getMerchants = cache(async () => {
  await connection();
  return db.merchant.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
});

// A description is split into comparable tokens on whitespace and `#`, with
// leading/trailing punctuation trimmed but internal punctuation kept — so a
// counterparty's dashed account number (a stable signal) survives intact while a
// `#`-glued reference like `<ref>#<name>` separates into its volatile and stable
// halves.
function descriptionTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s#]+/)
      .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
      .filter(Boolean),
  );
}

/** Jaccard overlap of two token sets: shared tokens over their union, in [0, 1]. */
function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// How much description overlap counts as "similar". Two instances of the same
// recurring credit that differ only in their reference number score ~0.75;
// unrelated direct credits sharing just "direct"/"credit" score well under this.
const SIMILAR_THRESHOLD = 0.5;

/**
 * Other transactions that look like this one, so a category or merchant set here
 * can be applied to the whole recurring set (e.g. every salary deposit, or every
 * tax refund) in one go.
 *
 * A candidate must share this transaction's `type` — a refund is never "like" a
 * payment. Beyond that it counts as similar if it shares the same linked merchant,
 * or if its description overlaps enough (see `SIMILAR_THRESHOLD`). Text matching is
 * scored in JS rather than SQL because recurring bank descriptions carry a volatile
 * reference number that an exact `WHERE description = …` would never group: the
 * same recurring credit reads `…<ref-A>#<name> <party> <acct>` one month and
 * `…<ref-B># <name> <party> <acct>` the next.
 */
export async function getSimilarTransactions(
  tx: { id: string; type: string; description: string; merchantId: string | null },
  limit = 100,
) {
  await connection();

  // Same-type rows are the candidate pool; at this app's scale (a personal ledger
  // on local SQLite) scoring them in memory is cheap, and it is the only way to
  // catch the reference-number drift above.
  const candidates = await db.transaction.findMany({
    where: { type: tx.type, id: { not: tx.id } },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: { account: { select: { name: true, currency: true } } },
  });

  const sourceTokens = descriptionTokens(tx.description);

  return candidates
    .map((c) => {
      // A shared merchant is a definitive match; text overlap is the fallback for
      // the merchant-less inflows (salary, refunds) this feature mainly serves.
      const sameMerchant = tx.merchantId != null && c.merchantId === tx.merchantId;
      const score = sameMerchant ? 1 : tokenOverlap(sourceTokens, descriptionTokens(c.description));
      return { tx: c, score, sameMerchant };
    })
    .filter((s) => s.sameMerchant || s.score >= SIMILAR_THRESHOLD)
    // Best matches first; the sort is stable, so equal scores keep the newest-first
    // order the query already imposed.
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.tx);
}

export type SimilarTransaction = Awaited<ReturnType<typeof getSimilarTransactions>>[number];

export const getTransaction = cache(async (id: string) => {
  await connection();
  return db.transaction.findUnique({
    where: { id },
    // Only unresolved conflicts surface on the page; a dismissed one is settled
    // and stays out of the way until a future sync re-opens it.
    include: { account: true, conflicts: { where: { status: "open" } } },
  });
});

/** Sum of current balances across active accounts, grouped by currency. */
export async function getNetWorth() {
  await connection();
  const grouped = await db.account.groupBy({
    by: ["currency"],
    where: { status: "ACTIVE", currency: { not: null } },
    _sum: { balanceCurrent: true },
  });

  return grouped.map((row) => ({
    currency: row.currency!,
    total: row._sum.balanceCurrent ?? 0,
  }));
}

/** When the ingest task last completed, so the UI can show staleness. */
export async function getLastSync() {
  await connection();
  return db.syncRun.findFirst({
    where: { status: "success" },
    orderBy: { startedAt: "desc" },
  });
}
