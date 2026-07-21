import type { Comparison } from "./comparison/types";
import { UNCATEGORISED, UNKNOWN_MERCHANT } from "./comparison/types";
import { isKnownGroup } from "@/lib/categories";
import { slugify } from "@/lib/slug";
import type { SpendNode } from "@/ui/dashboard/spend-row";

// The pure data layer behind the comparison table: where each row links, and how
// a Comparison is turned into the recursive SpendNode trees the table renders.
// Kept apart from comparison.tsx so this is plain, testable logic with no JSX —
// the presentation imports the trees, not the other way round.

/** Colour follows the entity: a category keeps its slot in every period. */
export function slotColor(categories: string[], category: string): string {
  // Not a categorical entity — the absence of one. Grey, never a slot.
  if (category === UNCATEGORISED) return "var(--viz-unknown)";
  const index = categories.indexOf(category);
  // The palette holds eight. A ninth hue is indistinguishable from an existing
  // one, so the overflow wears the grey rather than twinning with a real slot.
  return index < 8 ? `var(--viz-${index + 1})` : "var(--viz-unknown)";
}

/**
 * Where a spending row leads. Every group has a page; "Uncategorised" is the
 * absence of a category, which gets its own list.
 */
function rowHref(category: string): string | null {
  if (category === UNCATEGORISED) return "/transactions/uncategorised";
  return isKnownGroup(category) ? `/categories/${slugify(category)}` : null;
}

/** A disclosure row leads to its subcategory's page under its group. */
function detailHref(category: string, label: string): string | null {
  return isKnownGroup(category) ? `/categories/${slugify(category)}/${slugify(label)}` : null;
}

/**
 * A merchant row leads to its id-keyed page. The chart groups by name, so the id
 * is looked up (see `Comparison.merchantIds`); the unnamed remainder has no page.
 */
function merchantHref(comparison: Comparison, merchant: string): string | null {
  if (merchant === UNKNOWN_MERCHANT) return null;
  const id = comparison.merchantIds.get(merchant);
  return id ? `/merchants/${id}` : null;
}

/**
 * An income subcategory leads to its page under its income group. The unnamed
 * remainder isn't a category with a page — it is exactly what the uncategorised
 * list holds, so it leads there instead.
 */
function incomeDetailHref(group: string | null, label: string): string | null {
  if (label === UNCATEGORISED) return "/transactions/uncategorised";
  return group ? detailHref(group, label) : null;
}

/**
 * The tree under one spending category: its subcategories, and their merchants.
 *
 * A merchant's page holds *all* its transactions, not only the ones under the
 * category the reader opened — that is what a merchant page is. Only a merchant
 * enrichment failed to name has nowhere to go.
 */
export function spendNode(comparison: Comparison, category: string): SpendNode {
  const { periods, spendCategories, spendSubcategories, spendMerchants } = comparison;
  const merchantsOf = spendMerchants.get(category);

  return {
    label: category,
    color: slotColor(spendCategories, category),
    href: rowHref(category),
    values: periods.map((p) => p.spend.get(category) ?? 0),
    children: (spendSubcategories.get(category) ?? []).map((label) => ({
      label,
      href: detailHref(category, label),
      values: periods.map((p) => p.spendDetail.get(category)?.get(label)?.total ?? 0),
      children: (merchantsOf?.get(label) ?? []).map((merchant) => ({
        label: merchant,
        href: merchantHref(comparison, merchant),
        logo: comparison.merchantLogos.get(merchant),
        values: periods.map(
          (p) => p.spendDetail.get(category)?.get(label)?.merchants.get(merchant) ?? 0,
        ),
        children: [],
      })),
    })),
  };
}

/**
 * The income rows: its groups ("Periodic Income", "Other Income") as collapsible
 * parents, each disclosing its NZFCC subcategories (Wages, Refunds…), and each of
 * those the merchants beneath — the income source — the way a spending category
 * does. The parent group wears no swatch: the colour lives on each subcategory, so
 * its bar segment and its row match, and the group is just the fold that keeps a
 * long list readable. A subcategory whose rows carry no group (there normally are
 * none — ingest defaults inflows to "Other Income") falls back to a flat row after
 * the groups. The merchant level stays hidden until a source is actually named
 * (see getComparison), so a refund or a wage can later carry the merchant it came
 * from.
 */
export function incomeNodes(comparison: Comparison): SpendNode[] {
  const { periods, incomeGroups, incomeGroupOf, incomeSubcategories, incomeMerchants } = comparison;

  const subNode = (label: string, group: string | null): SpendNode => ({
    label,
    color: slotColor(incomeSubcategories, label),
    href: incomeDetailHref(group, label),
    values: periods.map((p) => p.incomeDetail.get(label)?.total ?? 0),
    children: (incomeMerchants.get(label) ?? []).map((merchant) => ({
      label: merchant,
      href: merchantHref(comparison, merchant),
      logo: comparison.merchantLogos.get(merchant),
      values: periods.map((p) => p.incomeDetail.get(label)?.merchants.get(merchant) ?? 0),
      children: [],
    })),
  });

  // Subcategories keep their flat ranked order; here they're partitioned by group.
  const subsInGroup = (group: string) =>
    incomeSubcategories.filter((label) => incomeGroupOf.get(label) === group);

  const groupNodes: SpendNode[] = incomeGroups.map((group) => ({
    label: group,
    href: `/categories/${slugify(group)}`,
    values: periods.map((p) =>
      subsInGroup(group).reduce((sum, label) => sum + (p.incomeDetail.get(label)?.total ?? 0), 0),
    ),
    children: subsInGroup(group).map((label) => subNode(label, group)),
  }));

  // Any subcategory with no group at all sits flat after the groups rather than
  // vanishing — defensive, since ingest gives every inflow a group.
  const looseNodes = incomeSubcategories
    .filter((label) => !incomeGroupOf.get(label))
    .map((label) => subNode(label, null));

  return [...groupNodes, ...looseNodes];
}
