// No `import "server-only"`: budget inference is run by the worker (scripts/drain.ts,
// via lib/server/budget/run.ts) as well as being reachable in a request, and the
// worker is plain Node where `server-only` throws. It takes its scoped db as an
// argument rather than reaching for the request client, for the same reason.
import type { Prisma } from "../../generated/prisma/client";
import type { ScopedDb } from "../db";
import { money } from "../money";
import { displayFxFor } from "./fx";
import { completeMonths, monthKey, recencyWeightedMean } from "../../budget/months";
import {
  INFER_DAYS,
  INFER_MONTHS,
  RATE_MONTHS,
  RATE_WEEKS,
  detectAmount,
  detectAnchor,
  detectRate,
  detectRecurrence,
  isCurrent,
} from "../../budget/detect";
import type { Frequency } from "../../budget/recurrence";
import { describeRecurrence } from "../../budget/recurrence";
import { periodKey } from "../../periods";
import { inferViaLLM, isLlmAvailable } from "./llm";

// Reading a budget out of what already happened.
//
// The shape of the read follows lib/server/metrics/spend/summary.ts — same
// transfer exclusions, same per-day FX, same NZ month bucketing. What differs is
// the question: that module asks "what does a normal month cost", this one asks
// "what are the individual commitments, and when do they fall".
//
// Nothing here writes. The result is a *proposal*, reviewed and edited before a
// single row is created, because the whole value of seeding from history is lost
// if it puts figures nobody has agreed to in front of someone as though they had.

/** One row of the proposal. Not a `BudgetItem` — nothing exists yet. */
export type ProposedItem = {
  /** Stable within one proposal, so the review form can address a row. */
  key: string;
  name: string;
  /** Signed like `Transaction.amount`, in the display currency. */
  amount: number;
  frequency: Frequency;
  interval: number;
  anchorDate: Date;
  groupId: string;
  groupName: string;
  categoryId: string | null;
  categoryName: string | null;
  merchantId: string | null;
  merchantName: string | null;
  /** What the row rests on, in words: "12 payments over 24 months". */
  basis: string;
  /** The cadence in words, so the review table reads without decoding fields. */
  cadence: string;
  /**
   * `recurring` — a detected commitment.
   * `remainder` — the catch-all for a group's irregular spending. See below.
   */
  kind: "recurring" | "remainder";
  /**
   * How this row was produced: `ai` (the LLM named it) or `computed` (the
   * deterministic detector). Persisted on the row as `inferredSource` and surfaced
   * as the item's badge. Everything in this file is `computed`; the `ai` rows come
   * from `resolveProposedItems` in the LLM half.
   */
  source: "ai" | "computed";
};

export type BudgetProposal = {
  items: ProposedItem[];
  /** How much history there actually was, so the page can say when it is thin. */
  monthsOfHistory: number;
  /** How many transactions went into it, recurring or not. */
  transactions: number;
  currency: string;
};

type Row = {
  date: Date;
  amount: number;
  groupId: string;
  groupName: string;
  categoryId: string | null;
  categoryName: string | null;
  merchantId: string | null;
  merchantName: string | null;
};

/**
 * The key a stream is grouped by: the most specific identity available.
 *
 * A merchant-keyed stream is the strongest signal there is — same payee, same
 * amount, same rhythm — and the key degrades gracefully: a row with no merchant
 * still groups by category, and one with neither still groups by its spending
 * group. The alternative, grouping everything by category, buries a $180 power
 * bill inside a Utilities total and detects nothing.
 */
const streamKey = (row: Row) =>
  `${row.groupId}|${row.categoryId ?? ""}|${row.merchantId ?? ""}`;

export async function proposeBudgetFromHistory(
  db: ScopedDb,
  now: Date = new Date(),
): Promise<BudgetProposal> {
  const cutoff = new Date(now.getTime() - INFER_DAYS * 86_400_000);

  // The same two transfer tests the rest of the app uses: Akahu's tagged type and
  // a hand-linked group. A transfer between your own accounts is not income and
  // not spending, and budgeting for one would double-count the money.
  const rows = await db.transaction.findMany({
    where: {
      date: { gte: cutoff },
      type: { notIn: ["TRANSFER"] },
      transferGroupId: null,
      categoryGroupId: { not: null },
    },
    select: {
      date: true,
      amount: true,
      categoryGroupId: true,
      categoryGroup: { select: { name: true } },
      categoryId: true,
      category: { select: { name: true } },
      merchantId: true,
      merchant: { select: { name: true } },
      account: { select: { currency: true } },
    },
  });

  const { currency, toDisplay } = await displayFxFor(db);
  const typedRows = toTypedRows(rows, toDisplay);
  const items = detectItems(typedRows, now);
  return {
    items,
    monthsOfHistory: itemsMonthsOfHistory(rows, now),
    transactions: rows.length,
    currency,
  };
}

/** Run the deterministic detector over a subset of windows (used as LLM fallback). */
export async function proposeBudgetFromHistoryForWindows(
  db: ScopedDb,
  now: Date,
  windows: {
    groupId: string;
    txns: { date: string; amount: number; category: string | null; merchant: string | null }[];
  }[],
): Promise<{ items: ProposedItem[]; currency: string }> {
  const { currency } = await displayFxFor(db);

  const rows: Row[] = [];
  for (const window of windows) {
    for (const tx of window.txns) {
      rows.push({
        date: new Date(tx.date),
        amount: tx.amount,
        groupId: window.groupId,
        groupName: "", // not needed for detection
        categoryId: null,
        categoryName: tx.category,
        merchantId: null,
        merchantName: tx.merchant,
      });
    }
  }

  return { items: detectItems(rows, now), currency };
}

function itemsMonthsOfHistory(rows: { date: Date }[], now: Date): number {
  return Math.min(
    INFER_MONTHS,
    rows.length === 0
      ? 0
      : Math.round(
          (now.getTime() - Math.min(...rows.map((r) => r.date.getTime()))) / (30.44 * 86_400_000),
        ),
  );
}

function toTypedRows(
  rows: {
    date: Date;
    amount: Prisma.Decimal;
    categoryGroupId: string | null;
    categoryGroup: { name: string } | null;
    categoryId: string | null;
    category: { name: string } | null;
    merchantId: string | null;
    merchant: { name: string } | null;
    account: { currency: string | null };
  }[],
  toDisplay: (amount: number, currency: string, date: Date) => number,
): Row[] {
  const typed: Row[] = [];
  for (const raw of rows) {
    if (!raw.categoryGroupId || !raw.categoryGroup) continue;
    typed.push({
      date: raw.date,
      amount: toDisplay(money(raw.amount), raw.account.currency ?? "", raw.date),
      groupId: raw.categoryGroupId,
      groupName: raw.categoryGroup.name,
      categoryId: raw.categoryId,
      categoryName: raw.category?.name ?? null,
      merchantId: raw.merchantId,
      merchantName: raw.merchant?.name ?? null,
    });
  }
  return typed;
}

function detectItems(rows: Row[], now: Date): ProposedItem[] {
  const streams = new Map<string, Row[]>();
  for (const row of rows) {
    const key = streamKey(row);
    const list = streams.get(key);
    if (list) list.push(row);
    else streams.set(key, [row]);
  }

  const months = completeMonths(now);
  const monthsOfHistory = itemsMonthsOfHistory(rows, now);

  const items: ProposedItem[] = [];
  /** Everything the detector turned down, by group and month, for the remainder. */
  const leftover = new Map<string, { name: string; byMonth: Map<string, number> }>();

  const addLeftover = (row: Row) => {
    const entry = leftover.get(row.groupId) ?? { name: row.groupName, byMonth: new Map() };
    const key = monthKey(row.date);
    entry.byMonth.set(key, (entry.byMonth.get(key) ?? 0) + row.amount);
    leftover.set(row.groupId, entry);
  };

  // The recent windows the rate detector measures habits over: the last
  // RATE_WEEKS complete weeks and RATE_MONTHS complete months, oldest first. Built
  // once — they are the same for every stream — and each stream's spend is bucketed
  // into them below.
  const weekKeys = Array.from({ length: RATE_WEEKS }, (_, i) =>
    periodKey(new Date(now.getTime() - (RATE_WEEKS - i) * 7 * 86_400_000), "week"),
  );
  const rateMonths = months.slice(-RATE_MONTHS);

  for (const [key, stream] of streams) {
    const dates = stream.map((r) => r.date);
    const first = stream[0];
    const detected = detectRecurrence(dates);
    // A stream whose median is zero is a wash — a charge and its refund, most
    // likely — and has nothing to budget; it is not treated as a live bill.
    const amount = detectAmount(stream.map((r) => r.amount));

    // A scheduled bill: an even per-transaction cadence, still running as of now.
    // A lapsed rhythm (a salary that stopped in February) falls through, and the
    // recent-window rate check below will not revive it either.
    if (detected && isCurrent(dates, detected, now) && amount !== 0) {
      const anchorDate = detectAnchor(dates, detected.frequency);
      items.push({
        key,
        name: first.merchantName ?? first.categoryName ?? first.groupName,
        amount,
        frequency: detected.frequency,
        interval: detected.interval,
        anchorDate,
        groupId: first.groupId,
        groupName: first.groupName,
        categoryId: first.categoryId,
        categoryName: first.categoryName,
        merchantId: first.merchantId,
        merchantName: first.merchantName,
        basis: `${detected.occurrences} over ${monthsOfHistory} months${
          detected.spreadDays >= 1 ? `, ±${Math.round(detected.spreadDays)} days` : ""
        }`,
        cadence: describeRecurrence({
          frequency: detected.frequency,
          interval: detected.interval,
          anchorDate,
        }),
        kind: "recurring",
        source: "computed",
      });
      continue;
    }

    // Not a bill — try a habit: a scatter of purchases with no clean cadence but a
    // steady weekly or monthly rate (the supermarket shop). This is what rescues a
    // real commitment like Woolworths from being buried in the group's "Other …"
    // remainder, where it reads as an unnamed, any-category average.
    const weekTotals = weekKeys.map((wk) =>
      stream.reduce((sum, r) => (periodKey(r.date, "week") === wk ? sum + r.amount : sum), 0),
    );
    const monthTotals = rateMonths.map((mk) =>
      stream.reduce((sum, r) => (monthKey(r.date) === mk ? sum + r.amount : sum), 0),
    );
    const rate = detectRate(weekTotals, monthTotals);
    if (rate && rate.amount !== 0) {
      const anchorDate = detectAnchor(dates, rate.frequency);
      items.push({
        key,
        name: first.merchantName ?? first.categoryName ?? first.groupName,
        amount: rate.amount,
        frequency: rate.frequency,
        interval: 1,
        anchorDate,
        groupId: first.groupId,
        groupName: first.groupName,
        categoryId: first.categoryId,
        categoryName: first.categoryName,
        merchantId: first.merchantId,
        merchantName: first.merchantName,
        basis: `${rate.active} of ${rate.periods} ${rate.frequency}s`,
        cadence: describeRecurrence({ frequency: rate.frequency, interval: 1, anchorDate }),
        kind: "recurring",
        source: "computed",
      });
      continue;
    }

    // Neither a bill nor a habit: to the group's irregular remainder.
    for (const row of stream) addLeftover(row);
  }

  /**
   * The irregular remainder, one catch-all item per group — income groups included.
   *
   * Without this a budget holds only the tidy recurring bills and therefore
   * *systematically* undershoots — and the variance view would read "overspent"
   * every single month, for ever, which teaches the reader to ignore it. Sized by
   * the same recency-weighted mean the runway forecast is built on, so a category
   * that is trailing off fades out rather than being budgeted at its old level.
   *
   * Income groups are kept, not skipped: a budget now plans for more than the
   * detected recurring receipts, so the irregular money in — refunds, one-off lumps
   * — is carried as its own averaged line rather than being left out. The mean fades
   * anything that has trailed off, the same as it does for spending.
   */
  for (const [groupId, { name, byMonth }] of leftover) {
    const series = months.map((key) => byMonth.get(key) ?? 0);
    const mean = recencyWeightedMean(series);
    // Round to the dollar: a remainder is a estimate, and cents on it would
    // imply a precision it does not have.
    const amount = Math.round(mean);
    if (amount === 0) continue;

    // "Other food", "Other periodic income" — but not "Other other income": a group
    // whose own name already begins with "Other" is left to stand for its remainder.
    const label = name.toLowerCase().startsWith("other") ? name : `Other ${name.toLowerCase()}`;

    const anchorDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    items.push({
      key: `remainder|${groupId}`,
      name: label,
      amount,
      frequency: "month",
      interval: 1,
      anchorDate,
      groupId,
      groupName: name,
      categoryId: null,
      categoryName: null,
      merchantId: null,
      merchantName: null,
      basis: "everything else in this group, averaged",
      cadence: "Monthly, on the 1st",
      kind: "remainder",
      source: "computed",
    });
  }

  // Biggest commitments first: the rows most worth checking are the ones that
  // move the most money, and a proposal is read top-down.
  items.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return items;
}

/**
 * Propose a budget from history, by the best means available.
 *
 * The local LLM (`llm.ts`) when one is configured and answering; the deterministic
 * pattern detector above otherwise. Both return the identical `BudgetProposal`, so
 * every caller — the review page, the re-infer action — is indifferent to which ran.
 *
 * The model is preferred but never depended on: an endpoint that is unreachable, or
 * that fails partway through a run, drops through to `proposeBudgetFromHistory` so
 * the button that seeds a budget is never left broken by a model being down.
 */
export async function proposeBudget(
  db: ScopedDb,
  now: Date = new Date(),
): Promise<BudgetProposal> {
  if (await isLlmAvailable()) {
    try {
      return await inferViaLLM(db, now);
    } catch (error) {
      // Fall through to the deterministic path — a model that died mid-run must not
      // take the whole feature down with it — but say why in the worker log rather
      // than swallowing it, since a silent downgrade is exactly what hides a broken
      // model endpoint.
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`  [llm] inference failed (${reason}) — falling back to deterministic detection`);
    }
  } else {
    console.log("  [budget] no LLM reachable — using deterministic detection");
  }
  return proposeBudgetFromHistory(db, now);
}
