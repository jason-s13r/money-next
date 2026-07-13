// Categories come from the NZFCC — the New Zealand Financial Category Codes,
// an open standard published at https://nzfcc.org and applied by Akahu. Our
// `Transaction.categoryId` values are literal `nzfcc_...` ids, and
// `Transaction.categoryGroup` holds the `personal_finance` group name.
//
// Checked against NZFCC v2026.07.07 (208 categories):
//
//   * The `personal_finance` grouping has exactly the ten groups below, and
//     every one of them is a *spending* group.
//   * NZFCC's 26 credit-direction categories carry no `personal_finance` group
//     at all. That is why `categoryGroup` is null on every inflow, and why
//     `categoryGroup IS NOT NULL` is a faithful test for "this is spending"
//     rather than a lucky heuristic.
//
// Don't invent group names here. If NZFCC adds one, it shows up in
// `SpendSummary.unknownGroups` rather than being silently taken as
// discretionary.

import { fromSlug } from "./slug";

export type Necessity = "essential" | "discretionary";

/**
 * The complete `personal_finance` grouping, with our own judgement of what is
 * non-discretionary layered on top. The necessity call is ours, not NZFCC's.
 *
 * `Household` and `Professional Services` hold a mix of both and are treated as
 * discretionary, which makes the runway metric optimistic rather than
 * pessimistic. Revisit once you can see what's in them.
 */
export const SPENDING_GROUPS = {
  Housing: "essential",
  Utilities: "essential",
  Food: "essential",
  Health: "essential",
  Transport: "essential",
  Appearance: "discretionary",
  Education: "discretionary",
  Household: "discretionary",
  Lifestyle: "discretionary",
  "Professional Services": "discretionary",
  'Periodic Income': "essential",
  'Other Income': "essential",
  'Uncategorised': "discretionary",
} as const satisfies Record<string, Necessity>;

export type SpendingGroup = keyof typeof SPENDING_GROUPS;

export function isKnownGroup(group: string): group is SpendingGroup {
  return group in SPENDING_GROUPS;
}

/** Recurring receipts — wages, a benefit, regular support. The income the spend
 *  forecast is allowed to lean on: it keeps arriving, so it offsets the monthly
 *  burn. "Other Income" (refunds, one-offs) is deliberately not counted there. */
export const PERIODIC_INCOME_GROUP = "Periodic Income";

// The invented income groups (see lib/nzfcc.ts). Inflows carry no NZFCC group, so
// a credit category is filed under one of these — "Periodic Income" for recurring
// receipts, "Other Income" for the rest. Kept as one list so a query can exclude
// income in a single place and pages can tell an income group from a spending one.
export const INCOME_GROUP_NAMES = [PERIODIC_INCOME_GROUP, "Other Income"] as const;

export function isIncomeGroup(group: string): boolean {
  return (INCOME_GROUP_NAMES as readonly string[]).includes(group);
}

export function isEssential(group: string): boolean {
  return isKnownGroup(group) && SPENDING_GROUPS[group] === "essential";
}

/**
 * Categories struck from the spending forecast no matter how regularly they
 * recur. Tax is the case the recurrence filter can't catch on its own: a small
 * fee or interest charge lands most months, so the category looks recurring,
 * while the figure is really carried by provisional- and terminal-tax lumps of a
 * few thousand to tens of thousands. Averaging that in would describe a month
 * that never happens, so tax is excluded outright — it belongs to the emergency
 * runway's "what must I pay" reckoning, not the "cost of ordinary living" burn.
 *
 * Matched by NZFCC category id, which is stable where names are not. Accountant
 * fees ("Accountancy… and tax services") are a genuine recurring cost and stay.
 */
export const FORECAST_EXCLUDED_CATEGORY_IDS: ReadonlySet<string> = new Set([
  "nzfcc_ckouvvzbj005z08mle3z667go", // Tax payments
]);

export const SPENDING_GROUP_NAMES = Object.keys(SPENDING_GROUPS) as SpendingGroup[];

/** The spending group a `/categories/[group]` slug names, or null if none does. */
export function groupFromSlug(slug: string): SpendingGroup | null {
  const name = fromSlug(SPENDING_GROUP_NAMES, slug);
  return name && isKnownGroup(name) ? name : null;
}

// Akahu account types (not NZFCC), from `/accounts`.

/** Balances that cannot be spent this decade. */
export const LOCKED_TYPES: ReadonlySet<string> = new Set(["KIWISAVER", "INVESTMENT"]);

/** Balances that are spendable today. `FOREIGN` covers Wise-style multi-currency
 *  balances, which spend like cash (converted to the display currency in the
 *  liquid total), so they count here rather than sitting apart as untouchable. */
export const LIQUID_TYPES: ReadonlySet<string> = new Set([
  "CHECKING",
  "SAVINGS",
  "WALLET",
  "FOREIGN",
]);
