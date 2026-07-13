import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { db } from "./db";
import { FX_BASE_CURRENCY } from "./fx";
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

// The one currency every listing's amounts are compared and totalled in. Accounts
// are held in AUD/CHF/EUR/USD as well as NZD, so a raw column of mixed-currency
// amounts (and a raw sum of them) would be nonsense; each row also carries its
// value here, and the header totals in it. Matches `format.ts`'s default.
const DISPLAY_CURRENCY = "NZD";

/**
 * The newest rate on record for each of `currencies` (plus `DISPLAY_CURRENCY`,
 * always needed as the conversion target), keyed by currency. Rates are units per
 * 1 EUR (see `FxRate`), so EUR is 1 and added without a lookup. "Newest" rather
 * than transaction-dated: a listing values every row at what it is worth *now*,
 * one rate per currency, so the column and the header total stay consistent
 * without a per-row date lookup.
 */
async function latestFxRates(currencies: (string | null)[]): Promise<Map<string, number>> {
  const wanted = [
    ...new Set(
      [...currencies, DISPLAY_CURRENCY].filter(
        (c): c is string => !!c && c !== FX_BASE_CURRENCY,
      ),
    ),
  ];
  const map = new Map<string, number>([[FX_BASE_CURRENCY, 1]]);
  if (wanted.length === 0) return map;

  // Newest-first, so the first row seen for a currency is its latest rate.
  const rows = await db.fxRate.findMany({
    where: { currency: { in: wanted } },
    orderBy: { date: "desc" },
  });
  for (const row of rows) if (!map.has(row.currency)) map.set(row.currency, row.rate);
  return map;
}

/** `amount` in `from` expressed in `DISPLAY_CURRENCY`, or null when a rate is missing. */
function convertToDisplay(
  amount: number,
  from: string | null,
  rates: Map<string, number>,
): number | null {
  if (!from) return null;
  const rateFrom = rates.get(from);
  const rateTo = rates.get(DISPLAY_CURRENCY);
  if (rateFrom == null || rateTo == null) return null;
  return (amount * rateTo) / rateFrom;
}

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
    latestFxRates(items.map((i) => i.account.currency)),
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
      amountBase: convertToDisplay(i.amount, i.account.currency, rates),
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
  const rates = await latestFxRates(accounts.map((a) => a.currency));

  let net = 0;
  for (const b of byAccount) {
    const raw = b._sum.amount ?? 0;
    net += convertToDisplay(raw, currencyById.get(b.accountId) ?? null, rates) ?? raw;
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
      // Same shape as `listTransactions` so the account page renders through the
      // shared `TransactionTable` — the `account` relation is redundant on a
      // single-account page (the column is hidden there) but keeps one row type.
      include: {
        account: { select: { id: true, name: true, currency: true } },
        merchant: { select: { name: true } },
      },
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
      include: {
        account: { select: { id: true, name: true, currency: true } },
        merchant: { select: { name: true } },
      },
    }),
    db.transaction.count({ where }),
    netInDisplay(where),
  ]);

  return { items: await enrichTransactions(rows), total, net };
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
 * Like the other listings this shows every match, transfers included: a search
 * for an account number or a payment reference should surface the transfer that
 * carries it, which is often the whole point of searching.
 */
export async function searchTransactions(query: string, page: number, perPage = TRANSACTIONS_PER_PAGE) {
  await connection();
  const where: Prisma.TransactionWhereInput = {
    OR: searchableFields.map((field) => ({ [field]: { contains: query } })),
  };
  const [rows, total, net] = await Promise.all([
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
    netInDisplay(where),
  ]);

  return { items: await enrichTransactions(rows), total, net };
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
  return listTransactions({
    categoryId: null,
    transferGroupId: null,
    type: {notIn: ['TRANSFER']}
  }, page);
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
  return db.merchant.findUnique({ where: { id } });
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

// How far apart the two legs of a transfer can settle. The out and in sides of an
// internal transfer usually clear within a day or two of each other; a week is a
// comfortable envelope without pulling in unrelated same-amount payments.
const TRANSFER_WINDOW_DAYS = 7;

// How far a candidate's amount may differ from exactly offsetting the source, to
// still count as its transfer leg. Wise (and others) skim a fee off one side — a
// -20000.76 debit lands as a +20000.00 credit, the 0.76 never appearing as its
// own row — so the legs don't always net to zero. This is the greater of $2 or 1%
// of the amount: enough to catch that skim, tight relative to the date/account/
// currency constraints that do the real narrowing.
function transferTolerance(amount: number): number {
  return Math.max(2, Math.abs(amount) * 0.01);
}

// How far a cross-currency leg's amount may sit from the FX-converted opposite of
// this one and still count as its counterpart. Retail transfers convert at a rate
// with a spread over the ECB mid-market rate stored in `FxRate`, plus fees, so the
// band is generous (±3%) — kept safe by the same different-account/opposite-sign/
// date-window constraints that gate the same-currency match.
const FX_TOLERANCE = 0.03;

/**
 * Convert `amount` from one currency to another using the mirrored ECB rates
 * (units per 1 EUR; see `FxRate`), or null when either side's rate is missing.
 * `ratesByCurrency` holds the nearest-on-or-before rate for the relevant date.
 */
function convertFx(
  amount: number,
  from: string | null,
  to: string | null,
  ratesByCurrency: Map<string, number>,
): number | null {
  if (!from || !to) return null;
  if (from === to) return amount;
  const rateFrom = ratesByCurrency.get(from);
  const rateTo = ratesByCurrency.get(to);
  if (rateFrom == null || rateTo == null) return null;
  return (amount * rateTo) / rateFrom;
}

/**
 * The most recent rate on or before `date` for each of `currencies`, keyed by
 * currency. ECB skips weekends and holidays, so a Saturday transaction reads
 * Friday's rate. EUR is the base and always 1, added without a lookup; nulls and
 * duplicates in the input are ignored.
 */
async function fxRatesOnOrBefore(
  currencies: (string | null)[],
  date: Date,
): Promise<Map<string, number>> {
  const wanted = [...new Set(currencies.filter((c): c is string => !!c && c !== FX_BASE_CURRENCY))];
  const map = new Map<string, number>([[FX_BASE_CURRENCY, 1]]);
  if (wanted.length === 0) return map;

  // Newest-first, so the first row seen for a currency is its nearest prior rate.
  const rows = await db.fxRate.findMany({
    where: { currency: { in: wanted }, date: { lte: date } },
    orderBy: { date: "desc" },
  });
  for (const row of rows) if (!map.has(row.currency)) map.set(row.currency, row.rate);
  return map;
}

/**
 * The other legs of the transfer this transaction belongs to — the rows sharing
 * its `transferGroupId`, itself excluded — newest first, or `[]` when it isn't
 * grouped. A group can hold more than the opposite leg: a currency-conversion
 * counterpart and a separate fee row can all sit in the same transfer.
 */
export async function getTransferGroupLegs(tx: { id: string; transferGroupId: number | null }) {
  await connection();
  if (tx.transferGroupId == null) return [];
  return db.transaction.findMany({
    where: { transferGroupId: tx.transferGroupId, id: { not: tx.id } },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: { account: { select: { name: true, currency: true } } },
  });
}

export type TransferLeg = Awaited<ReturnType<typeof getTransferGroupLegs>>[number];

/**
 * Transactions that look like the opposite leg of a transfer for this one, so a
 * leg can be linked in a click. Two kinds of candidate are found, both restricted
 * to *ungrouped* rows in a *different* account carrying the opposite sign:
 *
 * - `"amount"` — a same-currency counterpart whose amount offsets this one within
 *   `transferTolerance` (the band absorbs a skimmed fee, e.g. a -20000.76 debit
 *   against a +20000.00 credit). `delta` is the leftover the two don't cancel.
 *
 * - `"conversion"` — a *cross-currency* counterpart, where the two legs sit in
 *   different-currency balances and so never match on amount. Two independent
 *   signals qualify one, so a leg is caught whether or not the institutions agree
 *   on timing: (a) a Wise-style conversion booked as one atomic event — the same
 *   exact timestamp and near-identical descriptions ("Converted 775.80 USD to
 *   600.00 CHF"); or (b) an amount that lands within `FX_TOLERANCE` of this one
 *   converted at the ECB rate for the day (see `convertFx`), which catches a
 *   cross-institution transfer (Wise → Kiwibank, say) whose legs share neither
 *   timestamp nor wording. `delta` is null — there is no single-currency residual.
 *
 * Amount matches lead (closest first), then conversions; ties break on date
 * proximity. Candidates are offered even for an already-grouped tx so a further
 * leg can be added; only ungrouped rows are eligible to join.
 */
export async function getTransferCandidates(
  tx: { id: string; amount: number; date: Date; description: string; accountId: string },
  currency: string | null,
  windowDays = TRANSFER_WINDOW_DAYS,
  limit = 50,
) {
  await connection();

  const opposite = -tx.amount;
  const tol = transferTolerance(tx.amount);
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const window = {
    gte: new Date(tx.date.getTime() - windowMs),
    lte: new Date(tx.date.getTime() + windowMs),
  };
  // A transfer's other leg always moves money the other way.
  const oppositeSign: Prisma.FloatFilter = tx.amount > 0 ? { lt: 0 } : { gt: 0 };

  const [amountMatches, crossCurrency] = await Promise.all([
    db.transaction.findMany({
      where: {
        id: { not: tx.id },
        transferGroupId: null,
        accountId: { not: tx.accountId },
        amount: { gte: opposite - tol, lte: opposite + tol },
        account: { is: { currency } },
        date: window,
      },
      include: { account: { select: { name: true, currency: true } } },
    }),
    // Cross-currency counterparts: opposite-sign, different-account, different-
    // currency rows in the window. Scored below by same-instant conversion or by
    // an FX-converted amount match.
    db.transaction.findMany({
      where: {
        id: { not: tx.id },
        transferGroupId: null,
        accountId: { not: tx.accountId },
        amount: oppositeSign,
        date: window,
        account: { is: { currency: { not: currency } } },
      },
      include: { account: { select: { name: true, currency: true } } },
    }),
  ]);

  const sourceTokens = descriptionTokens(tx.description);
  const rates = await fxRatesOnOrBefore(
    [currency, ...crossCurrency.map((c) => c.account.currency)],
    tx.date,
  );
  const conversions = crossCurrency.filter((c) => {
    // (a) One atomic conversion: booked at the same instant, wording confirming it.
    if (
      c.date.getTime() === tx.date.getTime() &&
      tokenOverlap(sourceTokens, descriptionTokens(c.description)) >= SIMILAR_THRESHOLD
    ) {
      return true;
    }
    // (b) The amount converts, at the day's ECB rate, to within FX_TOLERANCE of the
    // opposite leg — how a cross-institution transfer with no shared timing reads.
    const expected = convertFx(opposite, currency, c.account.currency, rates);
    return expected != null && Math.abs(c.amount - expected) <= Math.abs(expected) * FX_TOLERANCE;
  });

  const candidates = [
    ...amountMatches.map((c) => ({
      ...c,
      kind: "amount" as const,
      delta: tx.amount + c.amount,
      // Same currency — no conversion to show.
      converted: null as number | null,
    })),
    ...conversions.map((c) => ({
      ...c,
      kind: "conversion" as const,
      delta: null,
      // The candidate's amount expressed in *this* transaction's currency, so the
      // reader can compare it against the amount on screen and see why they pair.
      converted: convertFx(c.amount, c.account.currency, currency, rates),
    })),
  ];

  const rank = (c: (typeof candidates)[number]) => (c.kind === "amount" ? 0 : 1);
  return candidates
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Math.abs(a.delta ?? 0) - Math.abs(b.delta ?? 0) ||
        Math.abs(a.date.getTime() - tx.date.getTime()) -
          Math.abs(b.date.getTime() - tx.date.getTime()),
    )
    .slice(0, limit);
}

export type TransferCandidate = Awaited<ReturnType<typeof getTransferCandidates>>[number];

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
