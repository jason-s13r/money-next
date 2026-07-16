// The vocabulary of the money-flow Sankey: its columns, its node shape, the
// labels it invents, and the order two of its columns must be read in.
//
// This sits apart from the adapter that builds the diagram (which is server-only,
// since it reads a Comparison) because the layout needs the same vocabulary to
// draw it. Both sides must agree, so there is one copy and it lives here.

import { isEssential, PERIODIC_INCOME_GROUP, OTHER_INCOME_GROUP } from "./categories";

/**
 * Which column a node belongs to. Money flows strictly from a lower depth to the
 * next one up, so these double as the diagram's left-to-right reading order.
 */
export const DEPTH = {
  /** Who the money came from — the employer, IRD, whoever paid. */
  incomeMerchant: 0,
  /** What kind of income it was — Wages, Tax refunds, Social welfare. */
  incomeSubcategory: 1,
  /** The spending group it went out through — Food, Household. */
  spendGroup: 2,
  /** What it was spent on — Supermarkets, Insurance. */
  spendSubcategory: 3,
  /** Who finally received it — Woolworths, Inland Revenue. */
  spendMerchant: 4,
} as const;

export type SankeyNode = {
  id: string;
  label: string;
  /** Which column this node sits in. See {@link DEPTH}. */
  depth: number;
  /** Dollar value this node represents (the thicker side of its links). */
  value: number;
  /** Colour token, kept consistent with the rest of the dashboard. */
  color: string;
  /** Parent label. Names the group an income or spend node sits under, which is
   *  what {@link compareIncome} ranks by and what keeps a node's id distinct from
   *  a same-named node under another group. */
  parent?: string | null;
};

export type SankeyLink = {
  source: string;
  target: string;
  value: number;
};

export type SankeyData = {
  nodes: SankeyNode[];
  links: SankeyLink[];
};

// The bucket each side folds its below-threshold nodes into. The spend merchant
// column has none — it drops what it can't name (see the adapter), so there is no
// "Other Merchants" here.

/** The payers too small to name, in the merchant column. Distinct from
 *  {@link OTHER_INCOME}: this one is *who* the money came from, that one is
 *  *what kind* it was, and they sit in neighbouring columns — sharing a label
 *  would put the same words twice across one link. */
export const OTHER_SOURCES = "Other sources";
/** The kinds of income too small to name, in the subcategory column. */
export const OTHER_INCOME = "Other Income";
export const OTHER_EXPENSES = "Other expenses";
/** Absorbs a surplus on the right, or funds a deficit from the left. */
export const SAVINGS = "Savings";

/** Synthetic catch-all buckets, which read as a remainder and so sit last. */
export const OTHER_BUCKETS: ReadonlySet<string> = new Set([
  OTHER_SOURCES,
  OTHER_INCOME,
  OTHER_EXPENSES,
]);

// The two income/spend columns carry an order that value alone can't express,
// so it is stated outright. These live here, exported, because both sides of the
// app must agree on them: the layout stacks the columns in this order, and the
// adapter's greedy allocation pairs them off in this order to keep its links from
// crossing. If the two ever disagreed the diagram would quietly grow crossings,
// so there is exactly one copy.

/** Regular income first, then irregular, then the bucket, then Savings. */
export function compareIncome(a: SankeyNode, b: SankeyNode): number {
  const rank = (n: SankeyNode) => {
    if (n.label === SAVINGS) return 3;
    if (n.parent === PERIODIC_INCOME_GROUP) return 0;
    if (n.parent === OTHER_INCOME_GROUP) return 1;
    return 2; // the synthetic OTHER_INCOME bucket, which has no group
  };
  return rank(a) - rank(b) || b.value - a.value;
}

/** Essentials first, then discretionary, then the bucket. */
export function compareSpendGroup(a: SankeyNode, b: SankeyNode): number {
  const rank = (n: SankeyNode) => {
    if (n.label === OTHER_EXPENSES) return 2;
    return isEssential(n.label) ? 0 : 1;
  };
  return rank(a) - rank(b) || b.value - a.value;
}
