import "server-only";

import { connection } from "next/server";
import { getDb } from "../../db";
import {
  FORECAST_EXCLUDED_CATEGORY_IDS,
  isEssential,
  isKnownGroup,
  PERIODIC_INCOME_GROUP_ID,
} from "../../../categories";
import { displayConverter, getDisplayCurrency } from "../../currency";
import { money } from "../../money";
import {
  completeMonths,
  FETCH_DAYS,
  forecastTotal,
  median,
  monthKey,
  type SpendSummary,
} from "./types";

// Spending over the last twelve complete months: the essential-spend median that
// anchors the emergency runway, and the recurs-most-months forecast that anchors
// the "life goes on" runway. There is no classifier, so a transaction's nature is
// read from the sign of `amount` and whether it carries a `categoryGroup` (see
// docs/metrics.md, Part 0).
//
// Month bucketing happens in JavaScript against an explicit NZ timezone rather
// than in SQL, so the boundary can't drift with the server's timezone: 287
// transactions fall in a different month under NZ time than under UTC — banks
// stamp most rows at midday UTC, which is evening in Auckland. If this is ever
// pushed into SQL, `date` is timestamptz, so it must be converted explicitly
// (`date AT TIME ZONE 'Pacific/Auckland'`) — `date_trunc` alone would silently
// bucket by UTC months and move that 287.

export async function getSpendSummary(): Promise<SpendSummary> {
  await connection();
  const db = await getDb();

  const cutoff = new Date(Date.now() - FETCH_DAYS * 24 * 60 * 60 * 1000);
  // Categorised spending (money out Akahu tagged with a `categoryGroup`) plus
  // periodic income (money in filed under "Periodic Income"). The spending drives
  // the essential/median runway and the burn forecast; the periodic income is the
  // recurring receipt the forecast runway is allowed to net off against. Both the
  // uncategorised outflow no group could name and one-off "Other Income" are left
  // out — neither describes a normal month.
  const rows = await db.transaction.findMany({
    where: {
      date: { gte: cutoff },
      OR: [
        { amount: { lt: 0 }, categoryGroupId: { not: null } },
        { amount: { gt: 0 }, categoryGroupId: PERIODIC_INCOME_GROUP_ID },
      ],
    },
    select: {
      date: true,
      amount: true,
      categoryGroup: { select: { name: true } },
      categoryId: true,
      category: { select: { name: true } },
      account: { select: { currency: true } },
    },
  });

  // Foreign spend counts at the rate on the day it happened, not as if it were
  // already in the display currency.
  const display = await getDisplayCurrency();
  const toDisplay = await displayConverter(display, rows.map((r) => r.account.currency));

  const keys = completeMonths(new Date());
  const window = new Set(keys);

  const categorisedByMonth = new Map(keys.map((k) => [k, 0]));
  const essentialByMonth = new Map(keys.map((k) => [k, 0]));
  const byCategory = new Map<string, number>();
  // Per-category monthly series, keyed by the specific category where Akahu named
  // one and by the group otherwise. The finer the key, the cleaner the forecast:
  // a lumpy tax payment is isolated in its own category rather than smeared across
  // the recurring spend that shares its group.
  const catMonths = new Map<string, Map<string, number>>();
  // Periodic income's own per-category monthly series, forecast the same way as
  // the burn so the runway can net the two: a benefit or wage that keeps arriving
  // offsets the spend it is meant to cover.
  const incomeMonths = new Map<string, Map<string, number>>();
  const unknownGroups = new Set<string>();
  let categorisedOut = 0;

  for (const row of rows) {
    const key = monthKey(row.date);
    if (!window.has(key)) continue;

    const group = row.categoryGroup?.name ?? null;
    if (group === null) continue;

    const raw = money(row.amount);
    const amount = toDisplay(raw, row.account.currency, row.date);

    // Money in is periodic income (the query lets no other inflow through): feed
    // its own recurrence-tested series and take no further part in the spend side.
    if (raw > 0) {
      const catKey = row.category?.name ?? group;
      let series = incomeMonths.get(catKey);
      if (!series) incomeMonths.set(catKey, (series = new Map()));
      series.set(key, (series.get(key) ?? 0) + amount);
      continue;
    }

    const spend = -amount;

    if (!isKnownGroup(group)) unknownGroups.add(group);

    categorisedOut += spend;
    categorisedByMonth.set(key, categorisedByMonth.get(key)! + spend);
    byCategory.set(group, (byCategory.get(group) ?? 0) + spend);
    if (isEssential(group)) {
      essentialByMonth.set(key, essentialByMonth.get(key)! + spend);
    }

    // Tax and the like never enter the forecast, even though small charges keep
    // them looking recurring — their lumps would describe a month that never is.
    if (row.categoryId && FORECAST_EXCLUDED_CATEGORY_IDS.has(row.categoryId)) continue;
    const catKey = row.category?.name ?? group;
    let series = catMonths.get(catKey);
    if (!series) catMonths.set(catKey, (series = new Map()));
    series.set(key, (series.get(key) ?? 0) + spend);
  }

  // Forecast burn and the periodic income that offsets it, each the summed
  // recency-weighted average of the categories that recur in at least half the
  // months (see forecastTotal). Irregular lumps fail the recurrence test on both
  // sides, so each reads as "a normal month" rather than being jolted by a one-off.
  const forecastBurn = forecastTotal(catMonths, keys);
  const forecastIncome = forecastTotal(incomeMonths, keys);

  return {
    months: keys.map((key) => ({
      key,
      categorised: categorisedByMonth.get(key)!,
      essential: essentialByMonth.get(key)!,
    })),
    byCategory: [...byCategory]
      .map(([group, total]) => ({ group, total }))
      .toSorted((a, b) => b.total - a.total),
    medianEssential: median(keys.map((k) => essentialByMonth.get(k)!)),
    forecastBurn: catMonths.size === 0 ? null : forecastBurn,
    forecastIncome,
    categorisedOut,
    unknownGroups: [...unknownGroups],
  };
}
