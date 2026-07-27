import "server-only";

import type { Comparison } from "../comparison/types";

// Types for the budget side of the comparison view.
//
// The important thing here is what is *absent*: there is no budget-shaped
// breakdown type. `buildBudgetComparison` emits the very same `Comparison` the
// historic view does, so `spendNode`/`incomeNodes`
// (lib/server/metrics/comparison-nodes.ts) and `SpendRow` render a plan with no
// changes at all. Two parallel row trees that had to be kept in step would be a
// standing invitation for the budget column and the actual column to disagree
// about what a row means.

/**
 * A budget breakdown: a `Comparison` plus a note of which budgets fed each
 * period.
 *
 * `contributors` exists because layering makes a total unattributable otherwise.
 * When December is twice November, the reader's first question is "why", and the
 * answer — "the Christmas budget also applies this month" — is not recoverable
 * from any figure in the table.
 */
export type BudgetComparison = Comparison & {
  /** Period key → the names of the budgets active in it, in display order. */
  contributors: Map<string, string[]>;
};

/** A budget in the selector: enough to name it and link to it. */
export type BudgetRef = {
  id: string;
  slug: string;
  name: string;
};

/**
 * The three views the breakdown page switches between, built together so they
 * are guaranteed to describe the same window with the same row tree.
 *
 * `variance` is actual − budget, per node: positive means more money moved than
 * was planned. For spending that is an overspend; for income it is a windfall.
 * The sign is deliberately not flipped for one of them — a table where the same
 * arithmetic means opposite things in two of its blocks cannot be read at a
 * glance, and the block headings ("Income", "Spending") already say which is
 * which.
 */
export type BudgetVsActual = {
  budget: BudgetComparison;
  actual: Comparison;
  variance: Comparison;
  /** Every budget that overlaps the window, for the selector. */
  available: BudgetRef[];
  /** The subset actually included, in display order. */
  selected: BudgetRef[];
};

/** Which of the three the table is showing. Drives `?view=` on the page. */
export const BUDGET_VIEWS = ["actual", "budget", "variance"] as const;
export type BudgetView = (typeof BUDGET_VIEWS)[number];

export function isBudgetView(value: string): value is BudgetView {
  return (BUDGET_VIEWS as readonly string[]).includes(value);
}

export const BUDGET_VIEW_LABELS: Record<BudgetView, string> = {
  actual: "Actual",
  budget: "Budget",
  variance: "Variance",
};
