import { db } from "../../db";
import { INCOME_GROUP_IDS, INCOME_GROUP_NAMES } from "../../../categories";
import { displayConverter, getDisplayCurrency } from "../../currency";
import { periodKey, periodWindow, type Period } from "../../../periods";
import {
  UNCATEGORISED,
  UNKNOWN_MERCHANT,
  type PeriodBreakdown,
  type Comparison,
  type SpendDetail,
} from "./types";

/** Descending by money. */
const ranked = (totals: Map<string, number>) =>
  [...totals].sort((a, b) => b[1] - a[1]).map(([label]) => label);

/** A merchant level with no *named* merchant reveals nothing but the total it
 *  sits under, so it is not offered — the "Unknown" remainder alone is a reveal
 *  that restates the row above. */
const rankedMerchants = (totals: Map<string, number>) =>
  [...totals.keys()].some((m) => m !== UNKNOWN_MERCHANT) ? ranked(totals) : [];

/** Whether a category appears in any period's bucket. */
const present = (
  periods: PeriodBreakdown[],
  pick: (p: PeriodBreakdown) => Map<string, number>,
  category: string,
) => periods.some((p) => (pick(p).get(category) ?? 0) > 0);

/** Build a blank period keyed by `key`. */
const blank = (key: string, currentKey: string): PeriodBreakdown => ({
  key,
  spend: new Map(),
  spendDetail: new Map(),
  incomeDetail: new Map(),
  incomeTotal: 0,
  spendTotal: 0,
  partial: key === currentKey,
});

export async function buildComparison(
  period: Period,
  count: number,
  offset = 0,
  now: Date = new Date(),
): Promise<Comparison> {
  const rows = await db.transaction.findMany({
    where: {
      type: { notIn: ["TRANSFER"] },
      transferGroupId: null,
    },
    select: {
      date: true,
      amount: true,
      categoryGroup: { select: { name: true } },
      category: { select: { name: true } },
      merchant: { select: { name: true } },
      merchantId: true,
      logo: true,
      account: { select: { currency: true } },
    },
  });

  const display = await getDisplayCurrency();
  const toDisplay = await displayConverter(
    display,
    rows.map((r) => r.account.currency),
  );

  const groupRows = await db.categoryGroup.findMany({ select: { id: true, name: true } });
  const groupName = new Map(groupRows.map((g) => [g.id, g.name]));

  const spendRanking = await db.transaction.groupBy({
    by: ["categoryGroupId"],
    where: { categoryGroupId: { notIn: [...INCOME_GROUP_IDS] } },
    _sum: { amount: true },
  });

  const byMagnitude = <T,>(rows: T[], value: (row: T) => number) =>
    [...rows].sort((a, b) => Math.abs(value(b)) - Math.abs(value(a)));

  const allSpendCategories = byMagnitude(spendRanking, (r) => r._sum.amount ?? 0)
    .map((r) => (r.categoryGroupId ? groupName.get(r.categoryGroupId) : undefined))
    .filter((name): name is string => name != null);

  const keys = periodWindow(now, period, count, offset);
  const currentKey = periodKey(now, period);
  const window = new Set(keys);
  const periods = new Map(keys.map((key) => [key, blank(key, currentKey)]));

  const incomeGroupOf = new Map<string, string | null>();
  const merchantLogos = new Map<string, string>();

  const newest = await db.transaction.aggregate({ _max: { date: true } });
  const latest = newest._max.date;
  const through = latest && periodKey(latest, period) === currentKey ? latest : null;

  const oldest = await db.transaction.aggregate({
    where: { amount: { not: 0 } },
    _min: { date: true },
  });
  const earliest = oldest._min.date;
  const hasOlder = earliest !== null && periodKey(earliest, period) < keys[0];

  for (const row of rows) {
    const key = periodKey(row.date, period);
    const bucket = periods.get(key);
    if (!bucket) continue;

    const value = Math.abs(toDisplay(row.amount, row.account.currency, row.date));

    if (row.amount > 0) {
      bucket.incomeTotal += value;
      const label = row.category?.name ?? UNCATEGORISED;
      if (!incomeGroupOf.has(label)) incomeGroupOf.set(label, row.categoryGroup?.name ?? null);
      const detail = bucket.incomeDetail.get(label) ?? { total: 0, merchants: new Map() };
      detail.total += value;
      const merchant = row.merchant?.name ?? UNKNOWN_MERCHANT;
      detail.merchants.set(merchant, (detail.merchants.get(merchant) ?? 0) + value);
      bucket.incomeDetail.set(label, detail);
      if (row.logo && merchant !== UNKNOWN_MERCHANT) merchantLogos.set(merchant, row.logo);
      continue;
    }

    const category = row.categoryGroup?.name ?? UNCATEGORISED;
    bucket.spend.set(category, (bucket.spend.get(category) ?? 0) + value);
    bucket.spendTotal += value;

    if (row.categoryGroup && row.category?.name) {
      const subcategory = row.category.name;
      const byCategory = bucket.spendDetail.get(category) ?? new Map<string, SpendDetail>();
      const detail = byCategory.get(subcategory) ?? { total: 0, merchants: new Map() };
      detail.total += value;
      const merchant = row.merchant?.name ?? UNKNOWN_MERCHANT;
      detail.merchants.set(merchant, (detail.merchants.get(merchant) ?? 0) + value);
      if (row.logo && merchant !== UNKNOWN_MERCHANT) merchantLogos.set(merchant, row.logo);
      byCategory.set(subcategory, detail);
      bucket.spendDetail.set(category, byCategory);
    }
  }

  const ordered = [...periods.values()];
  const max = Math.max(1, ...ordered.map((p) => Math.max(p.incomeTotal, p.spendTotal)));

  const subTotals = new Map<string, Map<string, number>>();
  const merchantTotals = new Map<string, Map<string, Map<string, number>>>();

  for (const p of ordered) {
    for (const [category, byCategory] of p.spendDetail) {
      const totals = subTotals.get(category) ?? new Map<string, number>();
      const byMerchant = merchantTotals.get(category) ?? new Map<string, Map<string, number>>();

      for (const [label, detail] of byCategory) {
        totals.set(label, (totals.get(label) ?? 0) + detail.total);
        const merchants = byMerchant.get(label) ?? new Map<string, number>();
        for (const [merchant, amount] of detail.merchants) {
          merchants.set(merchant, (merchants.get(merchant) ?? 0) + amount);
        }
        byMerchant.set(label, merchants);
      }

      subTotals.set(category, totals);
      merchantTotals.set(category, byMerchant);
    }
  }

  const spendSubcategories = new Map(
    [...subTotals].map(([category, totals]) => [category, ranked(totals)]),
  );

  const incomeSubTotals = new Map<string, number>();
  const incomeMerchantTotals = new Map<string, Map<string, number>>();
  for (const p of ordered) {
    for (const [label, detail] of p.incomeDetail) {
      incomeSubTotals.set(label, (incomeSubTotals.get(label) ?? 0) + detail.total);
      const merchants = incomeMerchantTotals.get(label) ?? new Map<string, number>();
      for (const [merchant, amount] of detail.merchants) {
        merchants.set(merchant, (merchants.get(merchant) ?? 0) + amount);
      }
      incomeMerchantTotals.set(label, merchants);
    }
  }

  const incomeSubcategories = ranked(incomeSubTotals);
  const incomeMerchants = new Map(
    [...incomeMerchantTotals].map(([label, merchants]) => [label, rankedMerchants(merchants)]),
  );

  const incomeGroups = INCOME_GROUP_NAMES.filter((group) =>
    [...incomeGroupOf.values()].includes(group),
  );

  const spendMerchants = new Map(
    [...merchantTotals].map(([category, byMerchant]) => [
      category,
      new Map([...byMerchant].map(([label, merchants]) => [label, rankedMerchants(merchants)])),
    ]),
  );

  const merchantRows = await db.merchant.findMany({ select: { id: true, name: true, logo: true } });
  const merchantIds = new Map<string, string>();
  for (const m of merchantRows) {
    if (!merchantIds.has(m.name)) merchantIds.set(m.name, m.id);
    if (m.logo && !merchantLogos.has(m.name)) merchantLogos.set(m.name, m.logo);
  }

  const spendBase = allSpendCategories;

  return {
    period,
    periods: ordered,
    spendCategories: present(ordered, (p) => p.spend, UNCATEGORISED)
      ? [...spendBase, UNCATEGORISED]
      : spendBase,
    incomeSubcategories,
    incomeGroups,
    incomeGroupOf,
    incomeMerchants,
    spendSubcategories,
    spendMerchants,
    merchantIds,
    merchantLogos,
    max,
    through,
    hasOlder,
  };
}
