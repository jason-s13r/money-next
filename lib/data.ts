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
      where,
      orderBy: [{ date: "desc" }, { id: "desc" }],
      skip: (page - 1) * perPage,
      take: perPage,
      include: { account: { select: { id: true, name: true, currency: true } } },
    }),
    db.transaction.count({ where }),
    db.transaction.aggregate({ where, _sum: { amount: true } }),
  ]);

  return { items, total, net: aggregate._sum.amount ?? 0 };
}

export type TransactionListItem = Awaited<ReturnType<typeof listTransactions>>["items"][number];

/**
 * Spending, and only spending.
 *
 * NZFCC assigns `personal_finance` groups to spending categories alone, but the
 * classifier can still mark a categorised row INTERNAL once it is matched to the
 * other leg of a transfer. Those rows are excluded from the dashboard's category
 * bars, so excluding them here too keeps a category page's total equal to the
 * number the reader clicked on.
 */
const SPENDING: Prisma.TransactionWhereInput = { flow: "EXPENSE" };

export function getGroupTransactions(group: string, page: number) {
  return listTransactions({ ...SPENDING, categoryGroup: group }, page);
}

export function getCategoryTransactions(group: string, category: string, page: number) {
  return listTransactions({ ...SPENDING, categoryGroup: group, categoryName: category }, page);
}

/** Spending no rule could name. The same rows the dashboard greys out. */
export function getUncategorisedTransactions(page: number) {
  return listTransactions({ ...SPENDING, categoryGroup: null }, page);
}

/**
 * Everything paid to (or refunded by) a merchant, in every direction — a
 * merchant page that hid the refunds would misstate what the merchant cost.
 */
export function getMerchantTransactions(merchant: string, page: number) {
  return listTransactions({ merchantName: merchant }, page);
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
    where: { ...SPENDING, categoryGroup: group, categoryName: { not: null } },
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

export const getTransaction = cache(async (id: string) => {
  await connection();
  return db.transaction.findUnique({
    where: { id },
    include: { account: true },
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
