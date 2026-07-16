import "server-only";
import { connection } from "next/server";
import { db } from "../../db";
import { money, transactionMoney } from "../../money";
import type { Prisma } from "../../../generated/prisma/client";
import { DEFAULT_SORT, type Sort } from "@/lib/transactions/sort";
import {
  DISPLAY_CURRENCY,
  enrichTransactions,
  listInclude,
  listTransactions,
  netInDisplay,
  TRANSACTIONS_PER_PAGE,
} from "./core";
import { getCardSuffixes, getCategoryNames, getTransactionTypes } from "./slugs";

// The transaction listings every "what is in this bucket?" page renders — keyed by
// account, category, merchant, card, type, or a free-text search. Each is a thin
// filter over the shared `listTransactions`/`enrichTransactions` machinery in
// `core.ts`; the slug resolvers that 404 an unknown key live in
// `slugs.ts`.

export { DISPLAY_CURRENCY, TRANSACTIONS_PER_PAGE } from "./core";
export type { TransactionListItem, TransferSummary } from "./core";
export { getCardSuffixes, getCategoryNames, getTransactionTypes } from "./slugs";

/**
 * One page of an account's transactions, newest first, with the total row count
 * so the caller can render page numbers.
 *
 * Offset pagination is fine at this scale (thousands of rows) and gives
 * addressable `?page=N` urls. Institutions report most transactions with a
 * midday timestamp rather than a real time, so thousands of rows tie on `date`
 * alone; `id` breaks the tie and keeps a row from appearing on two pages.
 */
export async function getAccountTransactions(
  accountId: string,
  page: number,
  perPage = TRANSACTIONS_PER_PAGE,
) {
  await connection();
  const [rows, total] = await Promise.all([
    db.transaction.findMany({
      where: { accountId },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      skip: (page - 1) * perPage,
      take: perPage,
      include: listInclude,
    }),
    db.transaction.count({ where: { accountId } }),
  ]);

  return { items: await enrichTransactions(rows.map(transactionMoney)), total };
}

/**
 * Every transaction across every account, newest first — the unfiltered listing.
 * No `where` key, so it spans all accounts and all types (transfers included).
 */
export function getRecentTransactions(page: number) {
  return listTransactions({}, page);
}

/**
 * Spending/receipts no rule could name: no specific category, and not a transfer
 * (Akahu's tagged type, nor a hand-linked group). The sign filter is deliberately
 * absent so an uncategorised inflow shows too. Shared with the review-queue metric
 * (see `getReviewQueue`) so the dashboard's count and this page's list can never
 * disagree about what "uncategorised" means.
 */
export const UNCATEGORISED_WHERE: Prisma.TransactionWhereInput = {
  categoryId: null,
  transferGroupId: null,
  type: { notIn: ["TRANSFER"] },
};

export function getGroupTransactions(group: string, page: number) {
  return listTransactions({ categoryGroup: { is: { name: group } } }, page);
}

export function getCategoryTransactions(group: string, category: string, page: number) {
  return listTransactions(
    { categoryGroup: { is: { name: group } }, category: { is: { name: category } } },
    page,
  );
}

// Every text field a reader might recognise a transaction by: the raw bank
// description, the enriched merchant/category names, and the
// particulars/code/reference/counterparty fields a bank splits a payment across.
//
// Every `contains` here must carry `mode: "insensitive"`. Postgres' LIKE is
// case-sensitive, unlike SQLite's, so without it a search for "countdown" stops
// matching "COUNTDOWN" — which is how banks write most descriptions. The
// insensitive form is backed by the pg_trgm index (see the migration), so it
// stays indexed rather than falling back to a scan.
const searchableScalarFields = [
  "description",
  "particulars",
  "code",
  "reference",
  "otherAccount",
] as const;

/**
 * Transactions whose text matches a free-text query, newest first, with the
 * whole result set's count and net amount for the header.
 *
 * Like the other listings this shows every match, transfers included: a search
 * for an account number or a payment reference should surface the transfer that
 * carries it, which is often the whole point of searching.
 */
export async function searchTransactions(query: string, page: number, perPage = TRANSACTIONS_PER_PAGE) {
  return listTransactions(
    {
      OR: [
        ...searchableScalarFields.map((field) => ({
          [field]: { contains: query, mode: "insensitive" },
        })),
        // The enriched merchant/category names are relations now, so they match
        // through a relation filter rather than a scalar column.
        { merchant: { is: { name: { contains: query, mode: "insensitive" } } } },
        { category: { is: { name: { contains: query, mode: "insensitive" } } } },
      ],
    },
    page,
    DEFAULT_SORT,
    perPage,
  );
}

/**
 * The uncategorised listing — every row matching {@link UNCATEGORISED_WHERE},
 * sortable by any visible column.
 *
 * Sorting by `amount` orders by *magnitude*, not signed value: this is the review
 * queue, worked biggest-first, and the queue mixes inflows and outflows (an
 * uncategorised refund alongside a payment), so the honest "largest" is `|amount|`
 * — the same measure the dashboard's review banner uses (see `getReviewQueue`).
 * Prisma can't express `ORDER BY abs(amount)`, so that one case fetches the
 * queue's ids and orders them here before hydrating the page. The queue is small
 * and already fetched whole for its percentile threshold, so this stays cheap.
 */
export function getUncategorisedTransactions(page: number, sort: Sort = DEFAULT_SORT) {
  if (sort.field === "amount") return listUncategorisedByMagnitude(page, sort.dir);
  return listTransactions(UNCATEGORISED_WHERE, page, sort);
}

async function listUncategorisedByMagnitude(
  page: number,
  dir: Sort["dir"],
  perPage = TRANSACTIONS_PER_PAGE,
) {
  await connection();
  const where = UNCATEGORISED_WHERE;
  const [all, net] = await Promise.all([
    db.transaction.findMany({ where, select: { id: true, amount: true } }),
    netInDisplay(where),
  ]);

  // Largest magnitude first (or last), with id as a stable tiebreak so a row can't
  // drift between pages when two amounts share a magnitude. Ordering only, so the
  // float comparison is enough — nothing is summed here.
  const ordered = all
    .map((r) => ({ id: r.id, amount: money(r.amount) }))
    .toSorted((a, b) => {
      const byMagnitude = Math.abs(b.amount) - Math.abs(a.amount);
      const signed = dir === "desc" ? byMagnitude : -byMagnitude;
      return signed !== 0 ? signed : b.id.localeCompare(a.id);
    });

  const pageIds = ordered.slice((page - 1) * perPage, page * perPage).map((r) => r.id);
  const rows = await db.transaction.findMany({ where: { id: { in: pageIds } }, include: listInclude });
  // `findMany`'s own order isn't the magnitude order, so restore it by id.
  const byId = new Map(rows.map((r) => [r.id, transactionMoney(r)]));
  const items = pageIds.map((id) => byId.get(id)!);

  return { items: await enrichTransactions(items), total: all.length, net };
}

/**
 * Everything paid to (or refunded by) a merchant, in every direction — a
 * merchant page that hid the refunds would misstate what the merchant cost.
 *
 * Keyed by the Akahu merchant id, so the url is stable and unambiguous. One
 * business can hold more than one id (Akahu has two for "Kamo Vets"), so this
 * lists exactly the id the reader clicked rather than every id sharing a name.
 */
export function getMerchantTransactions(merchantId: string, page: number) {
  return listTransactions({ merchantId }, page);
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

/**
 * Every transaction carrying a `type` (DEBIT, CREDIT, TRANSFER, EFTPOS, FEE, …),
 * in every direction — the type page is keyed only by that Akahu type.
 */
export function getTypeTransactions(type: string, page: number) {
  return listTransactions({ type }, page);
}
