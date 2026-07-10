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
} as const satisfies Record<string, Necessity>;

export type SpendingGroup = keyof typeof SPENDING_GROUPS;

export function isKnownGroup(group: string): group is SpendingGroup {
  return group in SPENDING_GROUPS;
}

export function isEssential(group: string): boolean {
  return isKnownGroup(group) && SPENDING_GROUPS[group] === "essential";
}

export const SPENDING_GROUP_NAMES = Object.keys(SPENDING_GROUPS) as SpendingGroup[];

/** The spending group a `/categories/[group]` slug names, or null if none does. */
export function groupFromSlug(slug: string): SpendingGroup | null {
  const name = fromSlug(SPENDING_GROUP_NAMES, slug);
  return name && isKnownGroup(name) ? name : null;
}

// Akahu account types (not NZFCC), from `/accounts`.

/** Balances that cannot be spent this decade. */
export const LOCKED_TYPES: ReadonlySet<string> = new Set(["KIWISAVER", "INVESTMENT"]);

/** Balances that are spendable today. */
export const LIQUID_TYPES: ReadonlySet<string> = new Set(["CHECKING", "SAVINGS", "WALLET"]);
