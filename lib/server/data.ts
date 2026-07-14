import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { db } from "./db";
import { convert, FALLBACK_DISPLAY_CURRENCY, loadRates } from "./currency";
import {
  readLearnedRules,
  readTransferAutoLink,
  matchesTransaction,
  type Graph,
  type LearnedRuleView,
} from "./rule-learning";
import type { Prisma } from "../generated/prisma/client";

// The dashboard reads only from SQLite. Nothing here calls Akahu — that happens
// out-of-band in scripts/ingest.ts, so page loads never wait on a bank refresh.
//
// Every query awaits `connection()` first. better-sqlite3 is synchronous, so
// without it these queries resolve during prerendering and the dashboard is
// baked into static HTML at build time — permanently showing whatever balances
// existed when it was built.

export async function getAccounts() {
  await connection();
  const accounts = await db.account.findMany({
    orderBy: [{ status: "asc" }, { connection: { name: "asc" } }, { name: "asc" }],
    include: {
      connection: { select: { id: true, name: true, logo: true } },
      _count: { select: { transactions: true } },
    },
  });

  // Prisma can't order by a relation count on SQLite, so sort in memory:
  // active status first, then accounts with any transactions ahead of empty
  // ones, then connection and name.
  return accounts.toSorted((a, b) => {
    if (a.status !== b.status) return a.status.localeCompare(b.status);
    const aHasTx = a._count.transactions > 0 ? 1 : 0;
    const bHasTx = b._count.transactions > 0 ? 1 : 0;
    if (aHasTx !== bHasTx) return bHasTx - aHasTx;
    const byConnection = a.connection.name.localeCompare(b.connection.name);
    if (byConnection !== 0) return byConnection;
    return a.name.localeCompare(b.name);
  });
}

// `generateMetadata` and the page component both need the record. Prisma isn't
// `fetch`, so it gets no automatic request memoization — `cache` supplies it and
// the second caller reuses the first query.
export const getAccount = cache(async (id: string) => {
  await connection();
  return db.account.findUnique({
    where: { id },
    include: { connection: { select: { id: true, name: true, logo: true } } },
  });
});

export const TRANSACTIONS_PER_PAGE = 50;

// The one currency every listing's amounts are compared and totalled in. Accounts
// are held in AUD/CHF/EUR/USD as well as NZD, so a raw column of mixed-currency
// amounts (and a raw sum of them) would be nonsense; each row also carries its
// value here, and the header totals in it. Fixed (unlike the dashboard's dynamic
// display currency) so a listing's column reads in one steady unit. Conversion
// itself lives in `lib/currency.ts`; a listing values every row at its currency's
// latest rate, so it loads rates with no date (see `loadRates`).
const DISPLAY_CURRENCY = FALLBACK_DISPLAY_CURRENCY;

// The relations every listing row carries beyond its own columns, so a page keyed
// by account, category, merchant, card, or type all render through the shared
// `TransactionTable`. `satisfies` keeps the literal shape so Prisma still infers
// each row's type. The `account` relation is redundant on a single-account page
// (the column is hidden there) but keeps one row type across every listing.
const listInclude = {
  account: { select: { id: true, name: true, currency: true, connection: { select: { logo: true } } } },
  merchant: { select: { name: true, logo: true } },
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
async function enrichTransactions<
  T extends {
    id: string;
    amount: number;
    accountId: string;
    transferGroupId: number | null;
    account: { currency: string | null };
  },
>(items: T[]) {
  const groupIds = [
    ...new Set(items.map((i) => i.transferGroupId).filter((id): id is number => id != null)),
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

  const byGroup = new Map<number, typeof legs>();
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
async function netInDisplay(where: Prisma.TransactionWhereInput): Promise<number> {
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
    const raw = b._sum.amount ?? 0;
    net += convert(raw, currencyById.get(b.accountId) ?? null, DISPLAY_CURRENCY, rates) ?? raw;
  }
  return net;
}

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

  return { items: await enrichTransactions(rows), total };
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
async function listTransactions(
  where: Prisma.TransactionWhereInput,
  page: number,
  perPage = TRANSACTIONS_PER_PAGE,
) {
  await connection();
  const [rows, total, net] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: [{ date: "desc" }, { id: "desc" }],
      skip: (page - 1) * perPage,
      take: perPage,
      include: listInclude,
    }),
    db.transaction.count({ where }),
    netInDisplay(where),
  ]);

  return { items: await enrichTransactions(rows), total, net };
}

export type TransactionListItem = Awaited<ReturnType<typeof listTransactions>>["items"][number];

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
 * Like the other listings this shows every match, transfers included: a search
 * for an account number or a payment reference should surface the transfer that
 * carries it, which is often the whole point of searching.
 */
export async function searchTransactions(query: string, page: number, perPage = TRANSACTIONS_PER_PAGE) {
  return listTransactions(
    { OR: searchableFields.map((field) => ({ [field]: { contains: query } })) },
    page,
    perPage,
  );
}

/** The uncategorised listing — every row matching {@link UNCATEGORISED_WHERE}. */
export function getUncategorisedTransactions(page: number) {
  return listTransactions(UNCATEGORISED_WHERE, page);
}

export type MatchingRule = LearnedRuleView & {
  categoryName: string | null;
  merchantName: string | null;
  /** The first matching rule wins (the table's `first` hit policy); the rest are
   *  shadowed by it and never fire for this transaction. */
  applied: boolean;
};

/**
 * The rules that act on one transaction, for the "Automation" panel on its page.
 * A pure predicate test against the active graph (see `matchesTransaction`) — no
 * engine round-trip — with the first match flagged `applied` and the outputs'
 * ids resolved to names. `transferMatches` is the auto-link rule's verdict.
 */
export async function getRulesForTransaction(tx: {
  type: string;
  description: string;
}): Promise<{ matching: MatchingRule[]; transferMatches: boolean }> {
  await connection();
  const doc = await db.ruleDocument.findFirst({ where: { active: true } });
  if (!doc) return { matching: [], transferMatches: false };

  const graph = JSON.parse(doc.content) as Graph;
  const matches = readLearnedRules(graph).filter((rule) => matchesTransaction(rule.match, tx));
  if (matches.length === 0) {
    return { matching: [], transferMatches: readTransferAutoLink(graph) && tx.type === "TRANSFER" };
  }

  // Resolve just the ids the matching rules reference.
  const categoryIds = matches.map((r) => r.categoryId).filter((v): v is string => v != null);
  const merchantIds = matches.map((r) => r.merchantId).filter((v): v is string => v != null);
  const [categories, merchants] = await Promise.all([
    db.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }),
    db.merchant.findMany({ where: { id: { in: merchantIds } }, select: { id: true, name: true } }),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const merchantName = new Map(merchants.map((m) => [m.id, m.name]));

  const matching: MatchingRule[] = matches.map((rule, i) => ({
    ...rule,
    categoryName: rule.categoryId ? categoryName.get(rule.categoryId) ?? rule.categoryId : null,
    merchantName: rule.merchantId ? merchantName.get(rule.merchantId) ?? rule.merchantId : null,
    applied: i === 0,
  }));
  return { matching, transferMatches: readTransferAutoLink(graph) && tx.type === "TRANSFER" };
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

/** A merchant by id, for its page's title and to 404 an unknown id. */
export const getMerchant = cache(async (id: string) => {
  await connection();
  return db.merchant.findUnique({
    where: { id },
    select: { id: true, name: true, website: true, logo: true },
  });
});

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

/** The transaction types on record, for resolving a slug back and 404ing unknowns. */
export const getTransactionTypes = cache(async () => {
  await connection();
  const rows = await db.transaction.findMany({
    distinct: ["type"],
    orderBy: { type: "asc" },
    select: { type: true },
  });
  return rows.map((row) => row.type);
});

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
    select: { id: true, name: true, logo: true },
  });
});

export const getTransaction = cache(async (id: string) => {
  await connection();
  return db.transaction.findUnique({
    where: { id },
    // Only unresolved conflicts surface on the page; a dismissed one is settled
    // and stays out of the way until a future sync re-opens it.
    include: {
      account: { include: { connection: { select: { id: true, name: true, logo: true } } } },
      conflicts: { where: { status: "open" } },
    },
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

/** Paginated history of every ingest run, newest first. */
export async function getSyncRuns(page: number) {
  await connection();
  const [items, total] = await Promise.all([
    db.syncRun.findMany({
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * SYNC_RUNS_PER_PAGE,
      take: SYNC_RUNS_PER_PAGE,
    }),
    db.syncRun.count(),
  ]);
  return { items, total };
}

export const SYNC_RUNS_PER_PAGE = 25;

export const RULE_RUNS_PER_PAGE = 25;

/** The rules execution log — runs newest first, each with its edit count. */
export async function getRuleRuns(page: number) {
  await connection();
  const [items, total] = await Promise.all([
    db.ruleRun.findMany({
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * RULE_RUNS_PER_PAGE,
      take: RULE_RUNS_PER_PAGE,
      include: { _count: { select: { applications: true } } },
    }),
    db.ruleRun.count(),
  ]);
  return { items, total };
}

export type RuleApplicationRow = {
  id: number;
  field: string;
  fromLabel: string | null;
  toLabel: string | null;
  /** The transaction as it stands now, or null if it has since been deleted. */
  transaction: {
    id: string;
    date: Date;
    description: string;
    amount: number;
    currency: string | null;
    merchantName: string | null;
  } | null;
};

/**
 * One rule run with the transactions it edited. The applications carry the
 * change labels; the current transaction rows are joined back in (in bulk) so the
 * report can link to each and show its date/amount, tolerating a since-deleted one.
 */
export async function getRuleRun(id: number) {
  await connection();
  const run = await db.ruleRun.findUnique({
    where: { id },
    include: { applications: { orderBy: { id: "asc" } } },
  });
  if (!run) return null;

  const txIds = [...new Set(run.applications.map((a) => a.transactionId))];
  const rows = await db.transaction.findMany({
    where: { id: { in: txIds } },
    select: {
      id: true,
      date: true,
      description: true,
      amount: true,
      merchantName: true,
      account: { select: { currency: true } },
    },
  });
  const txById = new Map(rows.map((r) => [r.id, r]));

  const applications: RuleApplicationRow[] = run.applications.map((a) => {
    const tx = txById.get(a.transactionId);
    return {
      id: a.id,
      field: a.field,
      fromLabel: a.fromLabel,
      toLabel: a.toLabel,
      transaction: tx
        ? {
            id: tx.id,
            date: tx.date,
            description: tx.description,
            amount: tx.amount,
            currency: tx.account.currency,
            merchantName: tx.merchantName,
          }
        : null,
    };
  });

  return { run, applications };
}
