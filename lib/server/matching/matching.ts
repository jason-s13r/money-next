import "server-only";
import { connection } from "next/server";
import { db } from "../db";
import { convert, loadRates } from "../currency";
import { transactionMoney } from "../money";
import type { Prisma } from "../../generated/prisma/client";

// Fuzzy matching of transactions against one another, for two features that share
// the same description-overlap scoring: finding other transactions *like* a given
// one (to bulk-apply a category or merchant), and finding the opposite *leg* of a
// transfer (to link the two sides of a move between accounts). Both score bank
// descriptions in JS rather than SQL because a recurring payment carries a volatile
// reference number that an exact `WHERE description = …` would never group.

// A description is split into comparable tokens on whitespace and `#`, with
// leading/trailing punctuation trimmed but internal punctuation kept — so a
// counterparty's dashed account number (a stable signal) survives intact while a
// `#`-glued reference like `<ref>#<name>` separates into its volatile and stable
// halves.
export function descriptionTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s#]+/)
      .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
      // Drop tokens carrying an unbroken run of 4+ digits: a per-transaction
      // reference or batch id (`payrollref778213004411`, `d783879600`) that changes
      // every instance, so it only ever lowers the overlap between two instances of
      // the same recurring payment. A dashed account number like `012-345-678` — a
      // *stable* shared signal — has only 3-digit groups and survives.
      .filter((t) => t !== "" && !/\d{4,}/.test(t)),
  );
}

/** Jaccard overlap of two token sets: shared tokens over their union, in [0, 1]. */
function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// How much description overlap counts as "similar". With volatile reference/batch
// numbers now dropped at tokenisation (see `descriptionTokens`), two instances of
// the same recurring credit that differ only in that reference score at or near
// 1.0; unrelated direct credits sharing just "direct"/"credit" score well under
// this.
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

  // Same-type rows are the candidate pool; at this app's scale (a personal
  // ledger) scoring them in memory is cheap, and it is the only way to catch the
  // reference-number drift above.
  const rows = await db.transaction.findMany({
    where: { type: tx.type, id: { not: tx.id } },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: {
      account: { select: { name: true, currency: true } },
      merchant: { select: { name: true } },
      category: { select: { name: true } },
    },
  });
  // These rows are rendered by a client component, so they cannot carry `Decimal`.
  const candidates = rows.map(transactionMoney);

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
    .toSorted((a, b) => b.score - a.score)
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
 * The other legs of the transfer this transaction belongs to — the rows sharing
 * its `transferGroupId`, itself excluded — newest first, or `[]` when it isn't
 * grouped. A group can hold more than the opposite leg: a currency-conversion
 * counterpart and a separate fee row can all sit in the same transfer.
 */
export async function getTransferGroupLegs(tx: { id: string; transferGroupId: number | null }) {
  await connection();
  if (tx.transferGroupId == null) return [];
  const legs = await db.transaction.findMany({
    where: { transferGroupId: tx.transferGroupId, id: { not: tx.id } },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: {
      account: { select: { name: true, currency: true } },
      merchant: { select: { name: true } },
    },
  });
  return legs.map(transactionMoney);
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
 *   converted at the ECB rate for the day (see `convert`), which catches a
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
  const oppositeSign: Prisma.DecimalFilter = tx.amount > 0 ? { lt: 0 } : { gt: 0 };

  const [amountRows, crossCurrencyRows] = await Promise.all([
    db.transaction.findMany({
      where: {
        id: { not: tx.id },
        transferGroupId: null,
        accountId: { not: tx.accountId },
        amount: { gte: opposite - tol, lte: opposite + tol },
        account: { is: { currency } },
        date: window,
      },
      include: {
        account: { select: { name: true, currency: true } },
        merchant: { select: { name: true } },
      },
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
      include: {
        account: { select: { name: true, currency: true } },
        merchant: { select: { name: true } },
      },
    }),
  ]);

  // Out of `Decimal` before any scoring: the comparisons below are all tolerance
  // bands and FX conversions, which are float arithmetic by nature.
  const amountMatches = amountRows.map(transactionMoney);
  const crossCurrency = crossCurrencyRows.map(transactionMoney);

  const sourceTokens = descriptionTokens(tx.description);
  const rates = await loadRates(
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
    const expected = convert(opposite, currency, c.account.currency, rates);
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
      converted: convert(c.amount, c.account.currency, currency, rates),
    })),
  ];

  const rank = (c: (typeof candidates)[number]) => (c.kind === "amount" ? 0 : 1);
  return candidates
    .toSorted(
      (a, b) =>
        rank(a) - rank(b) ||
        Math.abs(a.delta ?? 0) - Math.abs(b.delta ?? 0) ||
        Math.abs(a.date.getTime() - tx.date.getTime()) -
          Math.abs(b.date.getTime() - tx.date.getTime()),
    )
    .slice(0, limit);
}

export type TransferCandidate = Awaited<ReturnType<typeof getTransferCandidates>>[number];
