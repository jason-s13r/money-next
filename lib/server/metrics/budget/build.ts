import "server-only";

import { getDb } from "../../db/request";
import { displayConverter, getDisplayCurrency } from "../../currency";
import { money } from "../../money";
import { occurrencesIn, type Lifespan, type Frequency } from "../../../budget/recurrence";
import { periodEnd, periodKey, periodStart, periodWindow, type Period } from "../../../periods";
import {
  UNCATEGORISED,
  UNKNOWN_MERCHANT,
  type PeriodBreakdown,
  type SpendDetail,
} from "../comparison/types";
import type { BudgetComparison, BudgetRef } from "./types";

// The plan, bucketed exactly the way the history is.
//
// This is the mirror of comparison/build.ts, and reads deliberately like it: the
// same buckets are filled, in the same order, with the same "Uncategorised" and
// "Unknown" fallbacks. The only difference is the source — occurrences expanded
// from a recurrence, rather than rows read from a ledger — and every line where
// that shows is commented.
//
// Currency is converted at the occurrence's own date, like every other
// mixed-currency total on the dashboard. For a future occurrence there is no rate
// yet, so `displayConverter` falls back to the most recent one, which is the only
// honest answer available and the same one a balance gets.

/** Descending by money — the ranking every slot order here uses. */
const ranked = (totals: Map<string, number>) =>
  [...totals].toSorted((a, b) => b[1] - a[1]).map(([label]) => label);

/** A merchant level with no *named* merchant only restates the row above it, so
 *  it is not offered. Same rule as the historic side. */
const rankedMerchants = (totals: Map<string, number>) =>
  [...totals.keys()].some((m) => m !== UNKNOWN_MERCHANT) ? ranked(totals) : [];

const blank = (key: string, currentKey: string): PeriodBreakdown => ({
  key,
  spend: new Map(),
  spendDetail: new Map(),
  incomeDetail: new Map(),
  incomeTotal: 0,
  spendTotal: 0,
  partial: key === currentKey,
});

/** The item columns this builder needs, and the names it renders them under. */
type ItemRow = {
  amount: number;
  currency: string;
  frequency: string;
  interval: number;
  anchorDate: Date;
  categoryGroup: { name: string };
  category: { name: string } | null;
  merchant: { id: string; name: string; logo: string | null } | null;
};

/**
 * A budget breakdown over the same window the historic comparison uses.
 *
 * Layering is addition: every selected budget's items are expanded and summed
 * into one set of buckets. A seasonal budget therefore adds to the general one on
 * the days they overlap rather than replacing it — see the note on the `Budget`
 * model for why the alternative has no defensible answer.
 */
export async function buildBudgetComparison(
  budgetIds: string[],
  period: Period,
  count: number,
  offset = 0,
  now: Date = new Date(),
  options: { clipToNow?: boolean } = {},
): Promise<BudgetComparison> {
  const db = await getDb();

  const keys = periodWindow(now, period, count, offset);
  const currentKey = periodKey(now, period);
  const periods = new Map(keys.map((key) => [key, blank(key, currentKey)]));

  // The window's exact span. Unlike the historic builder, which overfetches and
  // lets the key decide membership, occurrences are *generated* — so the range is
  // the precise one and every date produced belongs to some bucket.
  const from = periodStart(keys[0], period);
  const fullTo = periodEnd(keys[keys.length - 1], period);

  // `clipToNow` stops the plan at today instead of running to the end of the
  // period in progress. It exists for the variance view and only for it.
  //
  // The current period is part-elapsed on the actual side by definition, so
  // comparing it against a *whole* month's plan makes every month read as a
  // dramatic underspend until the day it ends — which is not an insight, it is
  // an artefact of the calendar. Clipping puts both sides on the same elapsed
  // span. The budget view itself is never clipped: there the question is what the
  // whole period plans for, not what it has planned so far.
  const to = options.clipToNow && now < fullTo ? now : fullTo;

  const budgets = budgetIds.length
    ? await db.budget.findMany({
        where: { id: { in: budgetIds } },
        orderBy: [{ startsOn: { sort: "asc", nulls: "first" } }, { name: "asc" }],
        select: {
          id: true,
          name: true,
          startsOn: true,
          endsOn: true,
          repeatsAnnually: true,
          items: {
            select: {
              amount: true,
              currency: true,
              frequency: true,
              interval: true,
              anchorDate: true,
              categoryGroup: { select: { name: true } },
              category: { select: { name: true } },
              merchant: { select: { id: true, name: true, logo: true } },
            },
          },
        },
      })
    : [];

  const display = await getDisplayCurrency();
  const toDisplay = await displayConverter(
    display,
    budgets.flatMap((b) => b.items.map((i) => i.currency)),
  );

  const contributors = new Map<string, string[]>(keys.map((key) => [key, []]));
  const merchantIds = new Map<string, string>();
  const merchantLogos = new Map<string, string>();
  const incomeGroupOf = new Map<string, string | null>();

  const addTo = (bucket: PeriodBreakdown, item: ItemRow, value: number) => {
    const merchant = item.merchant?.name ?? UNKNOWN_MERCHANT;
    if (item.merchant) {
      if (!merchantIds.has(merchant)) merchantIds.set(merchant, item.merchant.id);
      if (item.merchant.logo && !merchantLogos.has(merchant)) {
        merchantLogos.set(merchant, item.merchant.logo);
      }
    }

    // Income and spending are told apart by the sign of the amount, exactly as
    // they are for a transaction — that is why BudgetItem.amount is signed.
    if (item.amount > 0) {
      bucket.incomeTotal += value;
      const label = item.category?.name ?? UNCATEGORISED;
      if (!incomeGroupOf.has(label)) incomeGroupOf.set(label, item.categoryGroup.name);
      const detail = bucket.incomeDetail.get(label) ?? { total: 0, merchants: new Map() };
      detail.total += value;
      detail.merchants.set(merchant, (detail.merchants.get(merchant) ?? 0) + value);
      bucket.incomeDetail.set(label, detail);
      return;
    }

    const group = item.categoryGroup.name;
    bucket.spend.set(group, (bucket.spend.get(group) ?? 0) + value);
    bucket.spendTotal += value;

    // Where this departs from the historic builder, deliberately: there, a row
    // with a group but no category is left out of the disclosure entirely, so a
    // group's children can sum to less than the group. A budget item's category
    // is optional and often absent ("$800 for Food", no subcategory), so leaving
    // those out would routinely hide most of a group's money one level down.
    // Filing them under the same "Uncategorised" label the rest of the app uses
    // keeps the children summing to their parent, and keeps the label — and so
    // the variance alignment — shared with the actual side.
    const subcategory = item.category?.name ?? UNCATEGORISED;
    const byCategory = bucket.spendDetail.get(group) ?? new Map<string, SpendDetail>();
    const detail = byCategory.get(subcategory) ?? { total: 0, merchants: new Map() };
    detail.total += value;
    detail.merchants.set(merchant, (detail.merchants.get(merchant) ?? 0) + value);
    byCategory.set(subcategory, detail);
    bucket.spendDetail.set(group, byCategory);
  };

  for (const budget of budgets) {
    const lifespan: Lifespan = {
      startsOn: budget.startsOn,
      endsOn: budget.endsOn,
      repeatsAnnually: budget.repeatsAnnually,
    };

    for (const row of budget.items) {
      const item: ItemRow = { ...row, amount: money(row.amount) };
      const occurrences = occurrencesIn(
        {
          frequency: item.frequency as Frequency,
          interval: item.interval,
          anchorDate: item.anchorDate,
        },
        lifespan,
        from,
        to,
      );

      for (const date of occurrences) {
        const key = periodKey(date, period);
        const bucket = periods.get(key);
        if (!bucket) continue;

        const value = Math.abs(toDisplay(item.amount, item.currency, date));
        addTo(bucket, item, value);

        const names = contributors.get(key)!;
        if (!names.includes(budget.name)) names.push(budget.name);
      }
    }
  }

  const ordered = [...periods.values()];
  const max = Math.max(1, ...ordered.map((p) => Math.max(p.incomeTotal, p.spendTotal)));

  // Slot orders, ranked over the whole window so a group keeps its place — and so
  // its colour — from one period to the next.
  const spendTotals = new Map<string, number>();
  const subTotals = new Map<string, Map<string, number>>();
  const merchantTotals = new Map<string, Map<string, Map<string, number>>>();
  const incomeSubTotals = new Map<string, number>();
  const incomeMerchantTotals = new Map<string, Map<string, number>>();

  for (const p of ordered) {
    for (const [group, total] of p.spend) {
      spendTotals.set(group, (spendTotals.get(group) ?? 0) + total);
    }

    for (const [group, byCategory] of p.spendDetail) {
      const totals = subTotals.get(group) ?? new Map<string, number>();
      const byMerchant = merchantTotals.get(group) ?? new Map<string, Map<string, number>>();

      for (const [label, detail] of byCategory) {
        totals.set(label, (totals.get(label) ?? 0) + detail.total);
        const merchants = byMerchant.get(label) ?? new Map<string, number>();
        for (const [merchant, amount] of detail.merchants) {
          merchants.set(merchant, (merchants.get(merchant) ?? 0) + amount);
        }
        byMerchant.set(label, merchants);
      }

      subTotals.set(group, totals);
      merchantTotals.set(group, byMerchant);
    }

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
  const incomeGroups = [
    ...new Set(incomeSubcategories.map((label) => incomeGroupOf.get(label)).filter((g): g is string => !!g)),
  ];

  return {
    period,
    periods: ordered,
    spendCategories: ranked(spendTotals),
    incomeSubcategories,
    incomeGroups,
    incomeGroupOf,
    incomeMerchants: new Map(
      [...incomeMerchantTotals].map(([label, merchants]) => [label, rankedMerchants(merchants)]),
    ),
    spendSubcategories: new Map([...subTotals].map(([group, totals]) => [group, ranked(totals)])),
    spendMerchants: new Map(
      [...merchantTotals].map(([group, byMerchant]) => [
        group,
        new Map([...byMerchant].map(([label, merchants]) => [label, rankedMerchants(merchants)])),
      ]),
    ),
    merchantIds,
    merchantLogos,
    max,
    // A plan has no "how far the data reaches": it reaches exactly as far as it is
    // written to. And paging is driven by the actual side, which knows where the
    // history really stops — see getBudgetVsActual.
    through: null,
    hasOlder: false,
    contributors,
  };
}

/** The overlap test a budget must pass to have anything to say in a window: an
 *  annually repeating one always could, so it is never excluded by date; otherwise
 *  a plain overlap, with an open end meaning unbounded. */
function overlapsWindow(from: Date, to: Date) {
  return {
    OR: [
      { repeatsAnnually: true },
      {
        AND: [
          { OR: [{ startsOn: null }, { startsOn: { lt: to } }] },
          { OR: [{ endsOn: null }, { endsOn: { gte: from } }] },
        ],
      },
    ],
  };
}

/** Every *base* budget whose lifespan could overlap the window, for the base
 *  selector. Layers are not offered here — a base carries its own into the view. */
export async function budgetsInWindow(
  period: Period,
  count: number,
  offset: number,
  now: Date,
): Promise<BudgetRef[]> {
  const db = await getDb();
  const keys = periodWindow(now, period, count, offset);
  const from = periodStart(keys[0], period);
  const to = periodEnd(keys[keys.length - 1], period);

  const rows = await db.budget.findMany({
    where: { baseBudgetId: null, ...overlapsWindow(from, to) },
    orderBy: [{ startsOn: { sort: "asc", nulls: "first" } }, { name: "asc" }],
    select: { id: true, name: true },
  });

  return rows;
}

/**
 * A base and the layers of it that are active in the window: the id list the
 * budget-vs-actual view layers together.
 *
 * The base is always included — it is what the reader selected — and each of its
 * layers is added only if its own window could overlap the one on screen, so a
 * Christmas layer shows up in December's columns and is silent the rest of the
 * year. Returns `[]` for a base id this workspace does not own, which the view
 * reads as "nothing to show" rather than falling back to everything.
 */
export async function baseWithActiveLayers(
  baseId: string,
  period: Period,
  count: number,
  offset: number,
  now: Date,
): Promise<string[]> {
  const db = await getDb();
  const keys = periodWindow(now, period, count, offset);
  const from = periodStart(keys[0], period);
  const to = periodEnd(keys[keys.length - 1], period);

  // Resolved through the scoped client, so a base id naming another workspace's
  // budget finds nothing and layers nothing.
  const base = await db.budget.findFirst({
    where: { id: baseId, baseBudgetId: null },
    select: { id: true },
  });
  if (!base) return [];

  const layers = await db.budget.findMany({
    where: { baseBudgetId: base.id, ...overlapsWindow(from, to) },
    select: { id: true },
  });

  return [base.id, ...layers.map((l) => l.id)];
}
