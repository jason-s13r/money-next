import { nzDate } from "../periods";
import type { Frequency } from "./recurrence";

// Deciding whether a run of transactions is a recurring commitment, and if so
// what its cadence, amount and anchor are.
//
// No database, no currency, no request: dates and amounts in, a proposal out.
// That is why it sits here beside `recurrence.ts` rather than under lib/server —
// it is arithmetic, it carries no `server-only`, and it is testable by the node
// runner without a database. The query half that feeds it lives in
// lib/server/budget/infer.ts, which is where the tenancy and the FX live.
// Every threshold lives here so the tests can pin them, because the thresholds
// *are* the feature — a detector that is too eager fills a budget with noise the
// user has to weed out, and one that is too strict finds nothing and leaves them
// typing. Both failures look like "it didn't work".

/**
 * How far back the seeder reads.
 *
 * Deliberately wider than the runway forecast's 12 months
 * (`lib/server/metrics/spend/types.ts`), and its own constant rather than a
 * reuse: an annual premium gives *one* observation and *zero* gaps in a 12-month
 * window, so a year-frequency item is not merely hard to detect there, it is
 * undetectable in principle.
 */
export const INFER_MONTHS = 24;
export const INFER_DAYS = Math.round(INFER_MONTHS * 365 / 12);

/** At least three occurrences, so there are two gaps to compare with each other.
 *  Two occurrences give one gap, which is consistent with itself by construction
 *  and therefore says nothing about whether anything recurs. */
export const MIN_OCCURRENCES = 3;

/** How far a gap may sit from the median and still count as the same cadence.
 *  The floor matters for short cadences, where a proportional tolerance alone
 *  would reject a weekly bill that slipped by a day. */
const TOLERANCE = 0.25;
const TOLERANCE_FLOOR_DAYS = 2;

/**
 * The cadences a stream can be recognised as, and the gap each implies.
 *
 * Month-based lengths are averages (30.44, not 30) because real monthly bills
 * drift with month length: a run of 28, 31, 30, 31 has a median of 30.5, and a
 * table built on exact 30s would call that a mismatch. **This is the case to get
 * right** — monthly is by far the most common real cadence, and a detector that
 * misses it finds almost nothing worth having.
 */
const CADENCES: { frequency: Frequency; interval: number; days: number }[] = [
  { frequency: "day", interval: 1, days: 1 },
  { frequency: "day", interval: 2, days: 2 },
  { frequency: "week", interval: 1, days: 7 },
  { frequency: "week", interval: 2, days: 14 },
  { frequency: "month", interval: 1, days: 30.44 },
  { frequency: "month", interval: 2, days: 60.88 },
  { frequency: "quarter", interval: 1, days: 91.31 },
  { frequency: "month", interval: 6, days: 182.62 },
  { frequency: "year", interval: 1, days: 365.25 },
];

const DAY_MS = 86_400_000;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Whole days between two instants, resolved as NZ calendar days. */
function daysBetween(a: Date, b: Date): number {
  const day = (d: Date) => {
    const { year, month, day: dd } = nzDate(d);
    return Date.UTC(year, month - 1, dd) / DAY_MS;
  };
  return day(b) - day(a);
}

export type Detected = {
  frequency: Frequency;
  interval: number;
  /** How many transactions the finding rests on. Shown to the user, because "12
   *  payments over 12 months" and "3 payments" deserve different trust. */
  occurrences: number;
  /** Mean absolute deviation of the gaps, in days. 0 is metronomic. */
  spreadDays: number;
};

/**
 * The cadence a run of dates recurs at, or null if it does not recur.
 *
 * Null is the common and correct answer. Most of what a person spends money on
 * is not a commitment, and calling it one would put a confident-looking figure in
 * front of them that nothing supports.
 */
export function detectRecurrence(dates: Date[]): Detected | null {
  if (dates.length < MIN_OCCURRENCES) return null;

  const sorted = [...dates].toSorted((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1], sorted[i]));

  // Two transactions on the same day are one event split across rows (a card
  // authorisation and its fee, a split payment), not a one-day cadence.
  const spaced = gaps.filter((gap) => gap > 0);
  if (spaced.length < MIN_OCCURRENCES - 1) return null;

  const typical = median(spaced);
  if (typical <= 0) return null;

  // Nearest cadence by *ratio*, not by absolute difference: a 3-day error means
  // something quite different at a weekly cadence than at an annual one.
  const best = CADENCES.reduce((a, b) =>
    Math.abs(Math.log(typical / a.days)) <= Math.abs(Math.log(typical / b.days)) ? a : b,
  );

  const within = (value: number, target: number) =>
    Math.abs(value - target) <= Math.max(TOLERANCE_FLOOR_DAYS, target * TOLERANCE);

  // The median has to actually look like the cadence it was snapped to, and every
  // gap has to look like the median. The first test rejects a stream whose rhythm
  // is real but is not one of ours (every 45 days); the second rejects a stream
  // with no rhythm at all that happens to average out near one.
  if (!within(typical, best.days)) return null;
  if (!spaced.every((gap) => within(gap, typical))) return null;

  const spreadDays =
    spaced.reduce((sum, gap) => sum + Math.abs(gap - typical), 0) / spaced.length;

  return {
    frequency: best.frequency,
    interval: best.interval,
    occurrences: sorted.length,
    spreadDays,
  };
}

/** Days one step of a cadence covers, matching the CADENCES table above. Used to
 *  express "how late is late" in the stream's own units rather than raw days, so
 *  the same slack means one thing for a weekly bill and another for a yearly one. */
const CADENCE_DAYS: Record<Frequency, number> = {
  once: Infinity,
  day: 1,
  week: 7,
  month: 30.44,
  quarter: 91.31,
  year: 365.25,
};

/**
 * How many cadence-cycles may elapse after the last occurrence before a stream is
 * judged to have **lapsed** rather than merely run late.
 *
 * 1.5 gives a full extra cycle of slack past the one you would already be
 * expecting: a monthly wage due at ~30 days is not called lapsed until ~46, a
 * fortnightly one not until ~21. The point is to separate "this is still running,
 * the next one just hasn't landed" from "this stopped months ago" — the salary
 * that ended in February and would otherwise be projected forward for ever. Its
 * own constant, and pinned by tests, because like every threshold here the number
 * *is* the behaviour.
 */
export const LAPSE_CYCLES = 1.5;

/**
 * Whether a detected stream is still running as of `now`, judged by how long it
 * has been since its most recent occurrence measured in its own cadence.
 *
 * Detection asks "is there a rhythm"; this asks "is that rhythm still going" —
 * two genuinely different questions, kept apart so a real-but-finished pattern
 * (a job that ended, a subscription cancelled) is recognised as *past* rather
 * than budgeted forward as though it were current. A lapsed stream is not
 * discarded by the caller so much as demoted: it falls through to the
 * recency-weighted remainder, which fades it out the same way the runway forecast
 * already fades stopped income.
 */
export function isCurrent(dates: Date[], detected: Detected, now: Date): boolean {
  const last = dates.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
  const sinceLast = daysBetween(last, now);
  const expectedGap = CADENCE_DAYS[detected.frequency] * Math.max(1, detected.interval);
  return sinceLast <= expectedGap * LAPSE_CYCLES;
}

/**
 * The figure to budget: the **median** of the amounts, not the mean.
 *
 * One holiday power bill, one month the insurance was paid twice, one refund —
 * any of these drags a mean somewhere no month has ever been. The median asks
 * "what is a normal one of these", which is the question a budget is asking.
 */
export function detectAmount(amounts: number[]): number {
  return Math.round(median(amounts) * 100) / 100;
}

/**
 * How many recent complete periods the rate detector inspects, and the share of
 * them a stream must appear in to be a habit at that cadence. Weekly wants *most*
 * weeks (a weekly shop that skips the odd holiday still clears 9 of 12); monthly
 * wants *half* the months, the same bar {@link RECUR_MIN_MONTHS} sets for the
 * runway forecast. Both windows end at "now", so a habit that has stopped fails on
 * recent coverage — the rate detector's own liveness — and one that has just
 * started passes as soon as it is dense enough, no matter how little history
 * precedes it. These *are* the feature; the tests pin them.
 */
export const RATE_WEEKS = 12;
export const RATE_MONTHS = 6;
export const WEEK_COVERAGE = 0.75;
export const MONTH_COVERAGE = 0.5;

export type Rate = {
  frequency: Extract<Frequency, "week" | "month">;
  /** The per-period figure to budget: the median of the period totals. */
  amount: number;
  /** Periods with any spend, and periods inspected — "10 of 12 weeks", for the basis. */
  active: number;
  periods: number;
};

function fits(totals: number[], min: number): Omit<Rate, "frequency"> | null {
  const periods = totals.length;
  if (periods === 0) return null;
  const active = totals.filter((total) => total !== 0).length;
  if (active < Math.ceil(periods * min)) return null;
  // Median of *all* the periods, zeros included, so a stream that is active most
  // weeks but not quite every week is sized by a normal active week rather than
  // by its peak, and the occasional skipped week pulls the figure down honestly.
  return { amount: detectAmount(totals), active, periods };
}

/**
 * A **habit**, recognised from its recent per-period totals rather than from any
 * per-transaction rhythm — the counterpart to {@link detectRecurrence}.
 *
 * That function finds bills: one payment per period, landing on a schedule, which
 * it recognises by the gaps between payments being even. This finds the other kind
 * of commitment entirely — the weekly supermarket shop, the fortnightly fuel — a
 * scatter of purchases with no clean cadence at all, whose *weekly or monthly
 * total* is the thing that recurs. Gap analysis rejects those (their gaps are
 * anything but even), which is exactly why this runs only once the caller's
 * {@link detectRecurrence} has declined: a real bill should read "Monthly, on the
 * 15th", not "a monthly rate".
 *
 * Weekly is tried first and wins when it clears the bar, because "every week" is
 * the more specific, more useful claim than "most months". `weekTotals` and
 * `monthTotals` are the stream's spend bucketed into the last {@link RATE_WEEKS}
 * and {@link RATE_MONTHS} complete periods, oldest first — the caller buckets,
 * because it owns the NZ calendar; this only decides.
 */
export function detectRate(weekTotals: number[], monthTotals: number[]): Rate | null {
  const week = fits(weekTotals, WEEK_COVERAGE);
  if (week) return { frequency: "week", ...week };
  const month = fits(monthTotals, MONTH_COVERAGE);
  if (month) return { frequency: "month", ...month };
  return null;
}

/** Monday = 0, matching the numbering `lib/periods.ts` uses for ISO weeks. */
function nzWeekday(date: Date): number {
  const { year, month, day } = nzDate(date);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/** The value occurring most often; ties go to the most recent observation. */
function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[values.length - 1];
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The anchor date to store: the most recent occurrence, moved onto the day the
 * stream *typically* falls on.
 *
 * Not simply the last occurrence, because the last one may be the odd one out —
 * a bill that lands on the 1st eleven times and the 3rd once should be budgeted
 * on the 1st. Taking the typical day and applying it to a recent date keeps both
 * the right day-of-period and the right phase for an interval greater than one.
 */
export function detectAnchor(dates: Date[], frequency: Frequency): Date {
  const sorted = [...dates].toSorted((a, b) => a.getTime() - b.getTime());
  const last = sorted[sorted.length - 1];
  const { year, month, day } = nzDate(last);

  if (frequency === "day" || frequency === "once") {
    return new Date(Date.UTC(year, month - 1, day));
  }

  if (frequency === "week") {
    const typical = mode(sorted.map(nzWeekday));
    const shift = typical - nzWeekday(last);
    return new Date(Date.UTC(year, month - 1, day + shift));
  }

  // Month, quarter and year all anchor on a day of the month.
  const typicalDay = Math.round(median(sorted.map((d) => nzDate(d).day)));
  const inMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(typicalDay, inMonth)));
}
