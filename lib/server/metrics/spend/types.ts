import "server-only";

// Public types and pure helpers shared by the spend summary and review queue.

export const NZ_TIMEZONE = "Pacific/Auckland";
export const MONTHS = 12;
/** Overfetch window: comfortably more than 12 months, filtered precisely below. */
export const FETCH_DAYS = 400;
/** A category joins the forecast only if it has spend in at least this many of
 *  the window's months — half of it. Monthly and near-monthly bills clear the
 *  bar; a one-off or annual lump recurs too rarely to, so it drops out of the
 *  forecast rather than inflating the estimated monthly burn. (Tax dribbles in
 *  most months yet is still lumpy, so it is excluded by id on top of this —
 *  see {@link FORECAST_EXCLUDED_CATEGORY_IDS}.) */
export const RECUR_MIN_MONTHS = Math.ceil(MONTHS / 2);

const monthFormat = new Intl.DateTimeFormat("en-NZ", {
  timeZone: NZ_TIMEZONE,
  year: "numeric",
  month: "2-digit",
});

/** `2026-06`, in NZ local time. */
export function monthKey(date: Date): string {
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
export function completeMonths(now: Date): string[] {
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

export function median(values: number[]): number | null {
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
export function recencyWeightedMean(oldestFirst: number[]): number {
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
export function forecastTotal(catMonths: Map<string, Map<string, number>>, keys: string[]): number {
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

export type ReviewQueue = {
  rows: number;
  /** How many rows sit at or above {@link threshold} — the ones to do first. */
  overThreshold: number;
  /** The dollar cut-off that defines those rows, or `null` when there are none. */
  threshold: number | null;
};
