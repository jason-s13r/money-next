import "server-only";
import { connection } from "next/server";

import { buildComparison } from "../comparison/build";
import {
  UNKNOWN_MERCHANT,
  type Comparison,
  type PeriodBreakdown,
  type SpendDetail,
} from "../comparison/types";
import { buildBudgetComparison, budgetsInWindow } from "./build";
import type { BudgetComparison, BudgetVsActual } from "./types";
import type { Period } from "../../../periods";

export type { BudgetComparison, BudgetRef, BudgetVsActual, BudgetView } from "./types";
export { BUDGET_VIEWS, BUDGET_VIEW_LABELS, isBudgetView } from "./types";
export { budgetsInWindow, baseWithActiveLayers } from "./build";

// Budget, actual and variance over one window, built together.
//
// Built together rather than fetched separately by the page because two of the
// three properties that make them comparable are not properties of either one
// alone: they must rank their categories identically (or the same group wears two
// colours), and they must expose the same rows (or a row present in one view
// vanishes when you switch to another). Both are settled here, once.

/** Descending by money — magnitude, so a variance ranks by size either way. */
const ranked = (totals: Map<string, number>) =>
  [...totals].toSorted((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([label]) => label);

const rankedMerchants = (totals: Map<string, number>) =>
  [...totals.keys()].some((m) => m !== UNKNOWN_MERCHANT) ? ranked(totals) : [];

/** Add `from` into `into`, key by key. */
function addInto(into: Map<string, number>, from: Map<string, number>, sign = 1) {
  for (const [key, value] of from) into.set(key, (into.get(key) ?? 0) + sign * value);
}

/**
 * Every total a comparison holds, flattened — the raw material for both the
 * merged slot orders and the variance.
 */
function totalsOf(comparison: Comparison) {
  const spend = new Map<string, number>();
  const spendSub = new Map<string, Map<string, number>>();
  const spendMerchants = new Map<string, Map<string, Map<string, number>>>();
  const incomeSub = new Map<string, number>();
  const incomeMerchants = new Map<string, Map<string, number>>();

  for (const p of comparison.periods) {
    addInto(spend, p.spend);

    for (const [group, byCategory] of p.spendDetail) {
      const subs = spendSub.get(group) ?? new Map<string, number>();
      const merchants = spendMerchants.get(group) ?? new Map<string, Map<string, number>>();
      for (const [label, detail] of byCategory) {
        subs.set(label, (subs.get(label) ?? 0) + detail.total);
        const byMerchant = merchants.get(label) ?? new Map<string, number>();
        addInto(byMerchant, detail.merchants);
        merchants.set(label, byMerchant);
      }
      spendSub.set(group, subs);
      spendMerchants.set(group, merchants);
    }

    for (const [label, detail] of p.incomeDetail) {
      incomeSub.set(label, (incomeSub.get(label) ?? 0) + detail.total);
      const byMerchant = incomeMerchants.get(label) ?? new Map<string, number>();
      addInto(byMerchant, detail.merchants);
      incomeMerchants.set(label, byMerchant);
    }
  }

  return { spend, spendSub, spendMerchants, incomeSub, incomeMerchants };
}

/** Combine two flattened total sets into one, for ranking across both. */
function combine(a: ReturnType<typeof totalsOf>, b: ReturnType<typeof totalsOf>) {
  const spend = new Map(a.spend);
  addInto(spend, b.spend);

  const spendSub = new Map<string, Map<string, number>>();
  for (const source of [a.spendSub, b.spendSub]) {
    for (const [group, subs] of source) {
      const into = spendSub.get(group) ?? new Map<string, number>();
      addInto(into, subs);
      spendSub.set(group, into);
    }
  }

  const spendMerchants = new Map<string, Map<string, Map<string, number>>>();
  for (const source of [a.spendMerchants, b.spendMerchants]) {
    for (const [group, byLabel] of source) {
      const into = spendMerchants.get(group) ?? new Map<string, Map<string, number>>();
      for (const [label, merchants] of byLabel) {
        const target = into.get(label) ?? new Map<string, number>();
        addInto(target, merchants);
        into.set(label, target);
      }
      spendMerchants.set(group, into);
    }
  }

  const incomeSub = new Map(a.incomeSub);
  addInto(incomeSub, b.incomeSub);

  const incomeMerchants = new Map<string, Map<string, number>>();
  for (const source of [a.incomeMerchants, b.incomeMerchants]) {
    for (const [label, merchants] of source) {
      const into = incomeMerchants.get(label) ?? new Map<string, number>();
      addInto(into, merchants);
      incomeMerchants.set(label, into);
    }
  }

  return { spend, spendSub, spendMerchants, incomeSub, incomeMerchants };
}

/**
 * The subtraction, node by node: actual − budget.
 *
 * Every level is a union of the two sides' keys, not an intersection. A category
 * that was budgeted for and never spent is the single most useful row in the
 * whole view, and an intersection would drop exactly that row.
 */
function varianceOf(budget: Comparison, actual: Comparison): PeriodBreakdown[] {
  const budgetByKey = new Map(budget.periods.map((p) => [p.key, p]));

  return actual.periods.map((a) => {
    const b = budgetByKey.get(a.key);

    const spend = new Map(a.spend);
    if (b) addInto(spend, b.spend, -1);

    const spendDetail = new Map<string, Map<string, SpendDetail>>();
    const groups = new Set([...a.spendDetail.keys(), ...(b?.spendDetail.keys() ?? [])]);
    for (const group of groups) {
      const actualSubs = a.spendDetail.get(group);
      const budgetSubs = b?.spendDetail.get(group);
      const labels = new Set([...(actualSubs?.keys() ?? []), ...(budgetSubs?.keys() ?? [])]);
      const byLabel = new Map<string, SpendDetail>();

      for (const label of labels) {
        const actualDetail = actualSubs?.get(label);
        const budgetDetail = budgetSubs?.get(label);
        const merchants = new Map<string, number>();
        if (actualDetail) addInto(merchants, actualDetail.merchants);
        if (budgetDetail) addInto(merchants, budgetDetail.merchants, -1);
        byLabel.set(label, {
          total: (actualDetail?.total ?? 0) - (budgetDetail?.total ?? 0),
          merchants,
        });
      }

      spendDetail.set(group, byLabel);
    }

    const incomeDetail = new Map<string, SpendDetail>();
    const incomeLabels = new Set([...a.incomeDetail.keys(), ...(b?.incomeDetail.keys() ?? [])]);
    for (const label of incomeLabels) {
      const actualDetail = a.incomeDetail.get(label);
      const budgetDetail = b?.incomeDetail.get(label);
      const merchants = new Map<string, number>();
      if (actualDetail) addInto(merchants, actualDetail.merchants);
      if (budgetDetail) addInto(merchants, budgetDetail.merchants, -1);
      incomeDetail.set(label, {
        total: (actualDetail?.total ?? 0) - (budgetDetail?.total ?? 0),
        merchants,
      });
    }

    return {
      key: a.key,
      spend,
      spendDetail,
      incomeDetail,
      incomeTotal: a.incomeTotal - (b?.incomeTotal ?? 0),
      spendTotal: a.spendTotal - (b?.spendTotal ?? 0),
      partial: a.partial,
    };
  });
}

/**
 * Budget, actual and variance for one window, sharing one row tree and one slot
 * order.
 *
 * Sharing the slot order is not cosmetic. `slotColor` picks a colour by a
 * category's index in `spendCategories`, so if the two sides ranked
 * independently, Food could be blue in the budget view and orange in the actual
 * one — and the reader, flicking between them to compare, would be comparing
 * colours that had quietly swapped meaning.
 */
export async function getBudgetVsActual(
  budgetIds: string[],
  period: Period,
  count: number,
  offset = 0,
  now: Date = new Date(),
): Promise<BudgetVsActual> {
  await connection();

  const [budget, elapsedBudget, actual, available] = await Promise.all([
    buildBudgetComparison(budgetIds, period, count, offset, now),
    // The same plan, stopped at today. Only the variance uses it — see the note
    // on `clipToNow`: measuring a part-elapsed month against a whole month's plan
    // reports a large underspend every month until it ends.
    buildBudgetComparison(budgetIds, period, count, offset, now, { clipToNow: true }),
    buildComparison(period, count, offset, now),
    budgetsInWindow(period, count, offset, now),
  ]);

  const merged = combine(totalsOf(budget), totalsOf(actual));

  const spendCategories = ranked(merged.spend);
  const incomeSubcategories = ranked(merged.incomeSub);
  const spendSubcategories = new Map(
    [...merged.spendSub].map(([group, subs]) => [group, ranked(subs)]),
  );
  const spendMerchants = new Map(
    [...merged.spendMerchants].map(([group, byLabel]) => [
      group,
      new Map([...byLabel].map(([label, merchants]) => [label, rankedMerchants(merchants)])),
    ]),
  );
  const incomeMerchants = new Map(
    [...merged.incomeMerchants].map(([label, merchants]) => [label, rankedMerchants(merchants)]),
  );

  // Income group order comes from the actual side, which uses the canonical
  // INCOME_GROUP_NAMES ordering; the budget's own groups fill in anything the
  // history has not seen yet (a budgeted income stream that has not started).
  const incomeGroups = [...new Set([...actual.incomeGroups, ...budget.incomeGroups])];
  const incomeGroupOf = new Map([...budget.incomeGroupOf, ...actual.incomeGroupOf]);
  const merchantIds = new Map([...budget.merchantIds, ...actual.merchantIds]);
  const merchantLogos = new Map([...budget.merchantLogos, ...actual.merchantLogos]);

  const shared = {
    period,
    spendCategories,
    incomeSubcategories,
    incomeGroups,
    incomeGroupOf,
    incomeMerchants,
    spendSubcategories,
    spendMerchants,
    merchantIds,
    merchantLogos,
  };

  const variancePeriods = varianceOf(elapsedBudget, actual);

  const selected = available.filter((b) => budgetIds.includes(b.id));

  return {
    // Paging is the history's business: it is the only side that knows whether
    // anything happened before this window. The budget view borrows the answer so
    // the pager does not change meaning when the view does.
    budget: { ...budget, ...shared, hasOlder: actual.hasOlder, contributors: budget.contributors },
    actual: { ...actual, ...shared },
    variance: {
      ...shared,
      periods: variancePeriods,
      max: Math.max(
        1,
        ...variancePeriods.map((p) => Math.max(Math.abs(p.incomeTotal), Math.abs(p.spendTotal))),
      ),
      through: actual.through,
      hasOlder: actual.hasOlder,
    },
    available,
    selected,
  };
}

/** One budget's own breakdown, for its plan page. No history, no variance. */
export async function getBudgetComparison(
  budgetIds: string[],
  period: Period,
  count: number,
  offset = 0,
  now: Date = new Date(),
): Promise<BudgetComparison> {
  await connection();
  return buildBudgetComparison(budgetIds, period, count, offset, now);
}
