import { INCOME_GROUP_IDS, INCOME_GROUP_NAMES, isIncomeGroup } from "../../../categories";
import { displayFxFor } from "../../budget/fx";
import type { ScopedDb } from "../../db";
import { money, moneySum } from "../../money";
import {
  fetchCutoff,
  periodKey,
  periodWindow,
  transactionPeriodKey,
  type Period,
} from "../../../periods";
import { taxYearFor } from "../../tax-year";
import {
  UNCATEGORISED,
  UNKNOWN_MERCHANT,
  type PeriodBreakdown,
  type Comparison,
  type SpendDetail,
} from "./types";

/** Descending by money. */
const ranked = (totals: Map<string, number>) =>
  [...totals].toSorted((a, b) => b[1] - a[1]).map(([label]) => label);

/** A merchant level with no *named* merchant reveals nothing but the total it
 *  sits under, so it is not offered — the "Unknown" remainder alone is a reveal
 *  that restates the row above. */
const rankedMerchants = (totals: Map<string, number>) =>
  [...totals.keys()].some((m) => m !== UNKNOWN_MERCHANT) ? ranked(totals) : [];

/** Whether a category appears in any period's bucket. Any movement counts, in
 *  either direction: the buckets hold signed nets, so a category can be worth
 *  showing while summing to less than nothing. */
const present = (
  periods: PeriodBreakdown[],
  pick: (p: PeriodBreakdown) => Map<string, number>,
  category: string,
) => periods.some((p) => (pick(p).get(category) ?? 0) !== 0);

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

/**
 * The comparison, against a passed-in scoped client rather than the request's.
 *
 * The db is a parameter because this no longer runs only under a request: a chat turn
 * is detached from the one that started it (see lib/server/chat/run.ts), so by the time
 * a model asks for these figures there is no ambient request to resolve a client from.
 * The pages pass `getDb()` — see ./index.
 */
export async function buildComparison(
  db: ScopedDb,
  period: Period,
  count: number,
  offset = 0,
  now: Date = new Date(),
): Promise<Comparison> {
  // Where this household's tax year starts. Read before anything is bucketed:
  // every key below is computed against it, and the `taxyear` ones are wrong
  // without it.
  const taxYear = await taxYearFor(db);

  const keys = periodWindow(now, period, count, offset, taxYear);

  // Only the window's rows are ever bucketed — every other row falls through the
  // `periods.get(key)` miss below — so don't read them. The bound is deliberately
  // generous and `offset` is folded into the count so that paging back still
  // reaches: a row's period is decided by its NZ key, and NZ leads UTC, so a
  // transaction stamped before the window's first UTC midnight can still belong to
  // it. Exact membership stays with the key; this only spares the read.
  //
  // The second branch is the tax-year override's doing. A date bound alone assumes
  // a row's bucket follows from its date, which is exactly what `Transaction.taxYear`
  // breaks: a payment dated before the cutoff and marked as belonging to a year
  // inside the window would be pruned here and silently never counted. Rows moved
  // the other way — inside the date bound, marked as another year's — need no help;
  // they simply miss their bucket below, which is the intended outcome.
  //
  // The rankings and the `hasOlder`/`through` probes below run their own queries
  // over all of history and are unaffected.
  const overrides =
    period === "taxyear" ? keys.map((key) => Number(key.slice(2))) : [];

  const rows = await db.transaction.findMany({
    where: {
      type: { notIn: ["TRANSFER"] },
      transferGroupId: null,
      OR: [
        { date: { gte: fetchCutoff(now, period, count + offset) } },
        ...(overrides.length ? [{ taxYear: { in: overrides } }] : []),
      ],
    },
    select: {
      date: true,
      taxYear: true,
      amount: true,
      categoryGroup: { select: { name: true } },
      category: { select: { name: true } },
      merchant: { select: { name: true } },
      merchantId: true,
      logo: true,
      account: { select: { currency: true } },
    },
  });

  // The worker-safe converter, which makes the same display-currency choice and applies
  // the same nearest-rate-on-or-before-the-day rule as the request-side one it replaced.
  const { toDisplay } = await displayFxFor(db);

  const groupRows = await db.categoryGroup.findMany({ select: { id: true, name: true } });
  const groupName = new Map(groupRows.map((g) => [g.id, g.name]));

  const spendRanking = await db.transaction.groupBy({
    by: ["categoryGroupId"],
    where: { categoryGroupId: { notIn: [...INCOME_GROUP_IDS] } },
    _sum: { amount: true },
  });

  const byMagnitude = <T,>(rows: T[], value: (row: T) => number) =>
    [...rows].toSorted((a, b) => Math.abs(value(b)) - Math.abs(value(a)));

  const allSpendCategories = byMagnitude(spendRanking, (r) => moneySum(r._sum.amount))
    .map((r) => (r.categoryGroupId ? groupName.get(r.categoryGroupId) : undefined))
    .filter((name): name is string => name != null);

  const currentKey = periodKey(now, period, taxYear);
  const periods = new Map(keys.map((key) => [key, blank(key, currentKey)]));

  const incomeGroupOf = new Map<string, string | null>();
  const merchantLogos = new Map<string, string>();

  const newest = await db.transaction.aggregate({ _max: { date: true } });
  const latest = newest._max.date;
  const through = latest && periodKey(latest, period, taxYear) === currentKey ? latest : null;

  const oldest = await db.transaction.aggregate({
    where: { amount: { not: 0 } },
    _min: { date: true },
  });
  const earliest = oldest._min.date;
  const hasOlder = earliest !== null && periodKey(earliest, period, taxYear) < keys[0];

  for (const row of rows) {
    // Not `periodKey`: a row someone has assigned to another tax year belongs to
    // that one, and this is the only bucketing in the historic view.
    const key = transactionPeriodKey(row, period, taxYear);
    const bucket = periods.get(key);
    if (!bucket) continue;

    const raw = money(row.amount);
    const signed = toDisplay(raw, row.account.currency, row.date);

    // The category decides which side a row falls on; its sign only decides whether
    // it adds to that side or nets off it. A debit filed under an income category —
    // a tax clawback against interest earned — belongs with the interest it offsets,
    // and a refund filed under Food belongs with the groceries it gives back. Split
    // by sign alone and each would land on the wrong side twice over: inventing a
    // phantom row there while leaving the figure it was meant to reduce overstated.
    // Only an uncategorised row has nothing to go on, so there the sign still decides.
    const group = row.categoryGroup?.name ?? null;
    const income = group ? isIncomeGroup(group) : signed > 0;
    // Positive is "more of this side", either way: money in on the income side,
    // money out on the spending side. So every total below sums in one direction and
    // an offsetting row simply subtracts.
    const value = income ? signed : -signed;

    if (income) {
      bucket.incomeTotal += value;
      const label = row.category?.name ?? UNCATEGORISED;
      if (!incomeGroupOf.has(label)) incomeGroupOf.set(label, group);
      const detail = bucket.incomeDetail.get(label) ?? { total: 0, merchants: new Map() };
      detail.total += value;
      const merchant = row.merchant?.name ?? UNKNOWN_MERCHANT;
      detail.merchants.set(merchant, (detail.merchants.get(merchant) ?? 0) + value);
      bucket.incomeDetail.set(label, detail);
      if (row.logo && merchant !== UNKNOWN_MERCHANT) merchantLogos.set(merchant, row.logo);
      continue;
    }

    const category = group ?? UNCATEGORISED;
    bucket.spend.set(category, (bucket.spend.get(category) ?? 0) + value);
    bucket.spendTotal += value;

    if (group && row.category?.name) {
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
    taxYear,
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
