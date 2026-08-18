// The NZFCC category catalog — the New Zealand Financial Category Codes that
// Akahu tags transactions with (see lib/categories.ts). Published as a flat,
// date-versioned list at a stable URL; we mirror it into a local `Category`
// table each sync so an `nzfcc_...` id resolves to a name and group without a
// network hop, and so a category the standard adds shows up rather than never.
//
// No `server-only`: the sync worker imports this from plain Node, where it throws.

export const NZFCC_CATEGORIES_URL = "https://nzfcc.org/downloads/categories.json";

/**
 * NZFCC's credit-direction (income) categories carry no `personal_finance`
 * group — that grouping only covers spending. We attach our own so income has a
 * group to sit under, named to match the `categoryGroup` ingest writes on inflows.
 * The ids are namespaced `group_custom_` so they can never be mistaken for a real
 * NZFCC `group_...` id.
 *
 * Income splits in two: recurring receipts (salary, benefits, rent…) sit under
 * "Periodic Income"; everything else — one-off refunds, withdrawals, payouts —
 * under "Other Income". This is the single place that split is defined; the group
 * rides on each transaction's `categoryGroup` from there.
 */
export const PERIODIC_INCOME_GROUP = { _id: "group_custom_periodic_income", name: "Periodic Income" } as const;
export const OTHER_INCOME_GROUP = { _id: "group_custom_other_income", name: "Other Income" } as const;

/**
 * The credit categories we treat as periodic — a recurring payment received. The
 * rest fall to "Other Income". Matched by name against NZFCC v2026.07.07's 26
 * credit categories; a name the standard adds later that we don't list simply
 * lands in "Other Income" until added here.
 */
const PERIODIC_INCOME = new Set<string>([
  "Salary or wages",
  "Bonuses or commissions",
  "Government superannuation",
  "Superannuation not elsewhere classified",
  "Social welfare",
  "Family support",
  "Property rental income",
  "Self employed income",
  "Regular income not elsewhere classified",
  "Interest",
  "Dividends",
]);

type RawGroup = { _id: string; name: string };

type RawCategory = {
  _id: string;
  name: string;
  direction: string;
  groups?: { personal_finance?: RawGroup };
};

type RawCatalog = { version: string; categories: RawCategory[] };

/** A category flattened to the shape the `Category` table stores. */
export type NzfccCategory = {
  id: string;
  name: string;
  direction: string;
  groupId: string | null;
  groupName: string | null;
};

/** The `personal_finance` group, or an invented income group for credit rows. */
function groupOf(category: RawCategory): RawGroup | null {
  const group = category.groups?.personal_finance;
  if (group) return group;
  // Only credit rows get an invented group. A debit row with no group is a real
  // gap in the standard we'd rather surface as null than silently mislabel.
  if (category.direction !== "credit") return null;
  return PERIODIC_INCOME.has(category.name) ? PERIODIC_INCOME_GROUP : OTHER_INCOME_GROUP;
}

function normaliseCategory(category: RawCategory): NzfccCategory {
  const group = groupOf(category);
  return {
    id: category._id,
    name: category.name,
    direction: category.direction,
    groupId: group?._id ?? null,
    groupName: group?.name ?? null,
  };
}

/** Fetch and flatten the published catalog. Throws on a non-2xx response. */
export async function fetchNzfccCatalog(): Promise<{
  version: string;
  categories: NzfccCategory[];
}> {
  const response = await fetch(NZFCC_CATEGORIES_URL);
  if (!response.ok) {
    throw new Error(
      `NZFCC categories fetch failed: ${response.status} ${response.statusText}`,
    );
  }
  const raw = (await response.json()) as RawCatalog;
  return { version: raw.version, categories: raw.categories.map(normaliseCategory) };
}
