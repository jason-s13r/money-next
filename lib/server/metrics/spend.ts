import "server-only";
import { connection } from "next/server";
import { db } from "../db";
import {
  FORECAST_EXCLUDED_CATEGORY_IDS,
  isEssential,
  isKnownGroup,
  PERIODIC_INCOME_GROUP,
} from "../../categories";
import { displayConverter, getDisplayCurrency } from "../currency";
import { UNCATEGORISED_WHERE } from "../data";

// Spending over the last twelve complete months: the essential-spend median that
// anchors the emergency runway, and the recurs-most-months forecast that anchors
// the "life goes on" runway. There is no classifier, so a transaction's nature is
// read from the sign of `amount` and whether it carries a `categoryGroup` (see
// docs/metrics.md, Part 0).
//
// Month bucketing happens in JavaScript against an explicit NZ timezone rather
// than in SQL. SQLite's `localtime` modifier reads the *server's* timezone, and
// 287 transactions fall in a different month under NZ time than under UTC —
// banks stamp most rows at midday UTC, which is evening in Auckland.

const NZ_TIMEZONE = "Pacific/Auckland";
const MONTHS = 12;
/** Overfetch window: comfortably more than 12 months, filtered precisely below. */
const FETCH_DAYS = 400;
/** A category joins the forecast only if it has spend in at least this many of
 *  the window's months — half of it. Monthly and near-monthly bills clear the
 *  bar; a one-off or annual lump recurs too rarely to, so it drops out of the
 *  forecast rather than inflating the estimated monthly burn. (Tax dribbles in
 *  most months yet is still lumpy, so it is excluded by id on top of this —
 *  see {@link FORECAST_EXCLUDED_CATEGORY_IDS}.) */
const RECUR_MIN_MONTHS = Math.ceil(MONTHS / 2);

const monthFormat = new Intl.DateTimeFormat("en-NZ", {
  timeZone: NZ_TIMEZONE,
  year: "numeric",
  month: "2-digit",
});

/** `2026-06`, in NZ local time. */
function monthKey(date: Date): string {
  const parts = monthFormat.formatToParts(date);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  return `${year}-${month}`;
}

/**
 * The last `MONTHS` *complete* calendar months, oldest first. The current month
 * is excluded: a month that is three days old always looks like a spending
 * collapse, and it would drag every median down with it.
 */
function completeMonths(now: Date): string[] {
  let [year, month] = monthKey(now).split("-").map(Number);
  const keys: string[] = [];
  for (let i = 0; i < MONTHS; i++) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    keys.unshift(`${year}-${String(month).padStart(2, "0")}`);
  }
  return keys;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Mean of a monthly series (oldest first) biased toward recent months: month i,
 * counting from 1 at the oldest, carries weight i, so the newest month counts
 * MONTHS times as much as the oldest. Divides by the whole window's weight,
 * including months with no spend, so a category that is trailing off is faded
 * out rather than forecast at its former level.
 */
function recencyWeightedMean(oldestFirst: number[]): number {
  let weighted = 0;
  let weight = 0;
  oldestFirst.forEach((value, i) => {
    weighted += (i + 1) * value;
    weight += i + 1;
  });
  return weight === 0 ? 0 : weighted / weight;
}

/**
 * The forecast figure for a set of per-category monthly series: for every
 * category that recorded something in at least {@link RECUR_MIN_MONTHS} of the
 * window's months, its {@link recencyWeightedMean recency-weighted} average
 * monthly amount, summed. Irregular lumps recur too rarely to clear the bar and
 * are left out, so the total reads as "a normal month" rather than being jolted
 * by a one-off. The shape is shared by the spending burn and the periodic-income
 * forecast — the only difference is which rows fed the series.
 */
function forecastTotal(catMonths: Map<string, Map<string, number>>, keys: string[]): number {
  let total = 0;
  for (const series of catMonths.values()) {
    const monthly = keys.map((k) => series.get(k) ?? 0);
    if (monthly.filter((v) => v > 0).length < RECUR_MIN_MONTHS) continue;
    total += recencyWeightedMean(monthly);
  }
  return total;
}

export type SpendSummary = {
  /** The 12 complete months the window covers, oldest first. */
  months: { key: string; categorised: number; essential: number }[];
  byCategory: { group: string; total: number }[];
  /** Typical month of non-discretionary spend. Null if there is no history. */
  medianEssential: number | null;
  /**
   * Estimated monthly spend if life carries on unchanged: the recency-weighted
   * average of every category that recurs in at least half the window's months,
   * summed. Irregular lumps — an annual premium — recur too rarely to clear the
   * bar, and tax is struck out by id besides, so neither inflates it. Unlike
   * {@link medianEssential} this includes discretionary spend: it is the cost of
   * a normal month, not the essentials-only floor. Null with no spending history.
   */
  forecastBurn: number | null;
  /**
   * Estimated monthly income that can be leaned on to cover that burn: the same
   * recency-weighted, recurs-most-months forecast as {@link forecastBurn}, but
   * built from the "Periodic Income" group — wages, a benefit, ongoing support.
   * One-off receipts ("Other Income") are excluded, and an income stream that has
   * stopped fades out under the recency weighting rather than being counted at its
   * old level. Zero when no periodic income recurs; it never inflates the runway.
   */
  forecastIncome: number;
  /** Total classified spending over the window. */
  categorisedOut: number;
  /**
   * Group names Akahu returned that aren't in our NZFCC map. Always empty today.
   * If the standard gains a group, this surfaces it instead of letting it be
   * silently counted as discretionary and quietly inflate the runway.
   */
  unknownGroups: string[];
};

export async function getSpendSummary(): Promise<SpendSummary> {
  await connection();

  const cutoff = new Date(Date.now() - FETCH_DAYS * 24 * 60 * 60 * 1000);
  // Categorised spending (money out Akahu tagged with a `categoryGroup`) plus
  // periodic income (money in filed under "Periodic Income"). The spending drives
  // the essential/median runway and the burn forecast; the periodic income is the
  // recurring receipt the forecast runway is allowed to net off against. Both the
  // uncategorised outflow no group could name and one-off "Other Income" are left
  // out — neither describes a normal month.
  const rows = await db.transaction.findMany({
    where: {
      date: { gte: cutoff },
      OR: [
        { amount: { lt: 0 }, categoryGroup: { not: null } },
        { amount: { gt: 0 }, categoryGroup: PERIODIC_INCOME_GROUP },
      ],
    },
    select: {
      date: true,
      amount: true,
      categoryGroup: true,
      categoryId: true,
      categoryName: true,
      account: { select: { currency: true } },
    },
  });

  // Foreign spend counts at the rate on the day it happened, not as if it were
  // already in the display currency.
  const display = await getDisplayCurrency();
  const toDisplay = await displayConverter(display, rows.map((r) => r.account.currency));

  const keys = completeMonths(new Date());
  const window = new Set(keys);

  const categorisedByMonth = new Map(keys.map((k) => [k, 0]));
  const essentialByMonth = new Map(keys.map((k) => [k, 0]));
  const byCategory = new Map<string, number>();
  // Per-category monthly series, keyed by the specific category where Akahu named
  // one and by the group otherwise. The finer the key, the cleaner the forecast:
  // a lumpy tax payment is isolated in its own category rather than smeared across
  // the recurring spend that shares its group.
  const catMonths = new Map<string, Map<string, number>>();
  // Periodic income's own per-category monthly series, forecast the same way as
  // the burn so the runway can net the two: a benefit or wage that keeps arriving
  // offsets the spend it is meant to cover.
  const incomeMonths = new Map<string, Map<string, number>>();
  const unknownGroups = new Set<string>();
  let categorisedOut = 0;

  for (const row of rows) {
    const key = monthKey(row.date);
    if (!window.has(key)) continue;

    const group = row.categoryGroup;
    if (group === null) continue;

    const amount = toDisplay(row.amount, row.account.currency, row.date);

    // Money in is periodic income (the query lets no other inflow through): feed
    // its own recurrence-tested series and take no further part in the spend side.
    if (row.amount > 0) {
      const catKey = row.categoryName ?? group;
      let series = incomeMonths.get(catKey);
      if (!series) incomeMonths.set(catKey, (series = new Map()));
      series.set(key, (series.get(key) ?? 0) + amount);
      continue;
    }

    const spend = -amount;

    if (!isKnownGroup(group)) unknownGroups.add(group);

    categorisedOut += spend;
    categorisedByMonth.set(key, categorisedByMonth.get(key)! + spend);
    byCategory.set(group, (byCategory.get(group) ?? 0) + spend);
    if (isEssential(group)) {
      essentialByMonth.set(key, essentialByMonth.get(key)! + spend);
    }

    // Tax and the like never enter the forecast, even though small charges keep
    // them looking recurring — their lumps would describe a month that never is.
    if (row.categoryId && FORECAST_EXCLUDED_CATEGORY_IDS.has(row.categoryId)) continue;
    const catKey = row.categoryName ?? group;
    let series = catMonths.get(catKey);
    if (!series) catMonths.set(catKey, (series = new Map()));
    series.set(key, (series.get(key) ?? 0) + spend);
  }

  // Forecast burn and the periodic income that offsets it, each the summed
  // recency-weighted average of the categories that recur in at least half the
  // months (see forecastTotal). Irregular lumps fail the recurrence test on both
  // sides, so each reads as "a normal month" rather than being jolted by a one-off.
  const forecastBurn = forecastTotal(catMonths, keys);
  const forecastIncome = forecastTotal(incomeMonths, keys);

  return {
    months: keys.map((key) => ({
      key,
      categorised: categorisedByMonth.get(key)!,
      essential: essentialByMonth.get(key)!,
    })),
    byCategory: [...byCategory]
      .map(([group, total]) => ({ group, total }))
      .sort((a, b) => b.total - a.total),
    medianEssential: median(keys.map((k) => essentialByMonth.get(k)!)),
    forecastBurn: catMonths.size === 0 ? null : forecastBurn,
    forecastIncome,
    categorisedOut,
    unknownGroups: [...unknownGroups],
  };
}

export type ReviewQueue = {
  rows: number;
  /** How many rows sit at or above {@link threshold} — the ones to do first. */
  overThreshold: number;
  /** The dollar cut-off that defines those rows, or `null` when there are none. */
  threshold: number | null;
};

/**
 * Spending with no `categoryId` — no specific NZFCC category, whether or not a
 * group was inferred. It is counted in the totals but belongs to no category, so
 * it is the queue a future classification step works through. Income is excluded:
 * its own uncategorised inflows are surfaced under the Income breakdown instead.
 *
 * Transfers are excluded on the same two tests used everywhere else — Akahu's
 * tagged `type` and the groups a user linked by hand (`transferGroupId`) — so
 * this count matches the uncategorised page it links to.
 *
 * The "do these first" cut-off is the 95th percentile of the queue's own amounts
 * rather than a fixed dollar figure: a fixed $500 line reads as "0 are over $500"
 * for anyone whose spending never reaches it, which is noise. A percentile always
 * points at the largest quarter of what is actually here.
 */
export async function getReviewQueue(percentile = 0.95): Promise<ReviewQueue> {
  await connection();
  const rows = await db.transaction.findMany({
    where: UNCATEGORISED_WHERE,
    select: { amount: true },
  });

  if (rows.length === 0) {
    return { rows: 0, overThreshold: 0, threshold: null };
  }

  const amounts = rows.map((r) => Math.abs(r.amount)).sort((a, b) => a - b);
  // Nearest-rank: the smallest amount with at least `percentile` of the queue at
  // or below it. Clamped so the last index is never overrun.
  const rank = Math.min(amounts.length - 1, Math.ceil(percentile * amounts.length) - 1);
  const threshold = amounts[Math.max(0, rank)];

  return {
    rows: rows.length,
    overThreshold: amounts.filter((a) => a >= threshold).length,
    threshold,
  };
}
