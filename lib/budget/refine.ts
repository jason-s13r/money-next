import type { Frequency } from "./recurrence";

// Nudging a budget's figures toward what actually happened.
//
// An inferred budget is a snapshot of the past; left alone it drifts out of date as
// spending changes. Refining pulls each item halfway to its recent actual —
// `budgeted = mean(budgeted, actual)` — so repeated refines converge on real
// behaviour without any single one throwing the plan away. Halfway rather than all
// the way on purpose: one unusual month should move the budget, not replace it.
//
// Pure, like its neighbours here. The server half gathers the matching transactions
// and converts them; this only does the arithmetic, so the arithmetic can be tested
// on numbers alone.

/** The default window recent actuals are measured over: six complete months, the
 *  same span the rate detector reads habits across. */
export const REFINE_MONTHS = 6;

/** Average calendar days in each cadence, for turning a window into an occurrence
 *  count. `once` has no rate, so it is never refined. */
const CADENCE_DAYS: Record<Frequency, number> = {
  once: Infinity,
  day: 1,
  week: 7,
  month: 30.44,
  quarter: 91.31,
  year: 365.25,
};

/** Halfway from the budgeted figure to the actual one. The whole rule, named so the
 *  call sites read as what they are and the test pins one thing. */
export function blendTowardActual(budgeted: number, actual: number): number {
  return (budgeted + actual) / 2;
}

/**
 * What one occurrence of an item actually cost, from the matching transactions in a
 * window.
 *
 * The signed total over the window, divided by how many occurrences of the item's
 * cadence the window holds — so a weekly item measured over six months is compared
 * against the average week, a monthly one against the average month, without
 * bucketing either by hand. Sign is preserved, so an expense stays negative.
 *
 * Null — meaning "do not refine this item" — when there is nothing to measure: a
 * `once` item has no rate, and an item with no matching transactions in the window
 * has no actual to pull toward (halving an annual premium that simply did not fall
 * in the window would be wrong, not conservative).
 */
export function actualPerOccurrence(
  amounts: number[],
  frequency: Frequency,
  interval: number,
  windowDays: number,
): number | null {
  if (frequency === "once") return null;
  if (amounts.length === 0) return null;

  const period = CADENCE_DAYS[frequency] * Math.max(1, interval);
  const occurrences = windowDays / period;
  if (occurrences <= 0) return null;

  const total = amounts.reduce((sum, a) => sum + a, 0);
  return total / occurrences;
}

/**
 * The refined amount for one item, or null to leave it as it is.
 *
 * Rounds to the cent: budgeted amounts are entered to the cent, and carrying more
 * precision than that would imply the blend knows something it does not.
 */
export function refinedAmount(
  budgeted: number,
  amounts: number[],
  frequency: Frequency,
  interval: number,
  windowDays: number,
): number | null {
  const actual = actualPerOccurrence(amounts, frequency, interval, windowDays);
  if (actual === null) return null;
  return Math.round(blendTowardActual(budgeted, actual) * 100) / 100;
}
