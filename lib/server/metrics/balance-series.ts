import "server-only";
import { connection } from "next/server";
import { getDb } from "../db";
import { displayConverter, getDisplayCurrency } from "../currency";
import { money } from "../money";
import { periodKey, periodStart, periodWindow } from "../../periods";
import type { BalanceSummary } from "./balance";
import type { SpendSummary } from "./spend";

// The dashboard's balance-over-time chart — a personal version of a stock price
// chart. "Balance" here is accessible net worth (the spendable accounts, locked
// KiwiSaver/investments left out). The resolution is always one day: a daily bar
// is the amount the balance moved that day (its net transaction flow), riding a
// daily balance line, with two forward burn-rate projections. The client zooms
// (how many days fill the width) and scrolls; the data here is the full daily
// history.
//
// Why the balance is reconstructed from transaction flows rather than read from
// BalanceSnapshot: Akahu only exposes the current balance, so snapshot history
// reaches back only as far as this app has been recording it (days), while the
// transaction ledger reaches back years. The accessible balance moves only when
// money moves through a spendable account — the locked KiwiSaver/investment
// accounts carry no transactions at all — so walking today's accessible figure
// backward by each day's net flow rebuilds the line exactly, and makes each bar
// the day's step in that very line. Transfers are excluded on the same two tests
// used everywhere else (Akahu's tagged type and a hand-linked `transferGroupId`),
// so a day's flow matches the net on the comparison view.

/** A ceiling on how many days are returned — generous (years), but bounded so a
 *  very old ledger does not ship an unbounded series. Beyond it the oldest days
 *  fall off the left; the reconstruction still anchors on today, so what remains
 *  is exact. */
const MAX_DAYS = 1830;

export type BalanceSeries = {
  displayCurrency: string;
  /** Now, as a timestamp — the right edge of the last day, where history meets the
   *  projections. */
  now: number;
  /** Accessible balance today: the anchor the line ends at and the projections
   *  start from. */
  currentWorth: number;
  /** Day keys (`YYYY-MM-DD`), oldest first — one per bar. */
  days: string[];
  /** Net transaction flow per day, oldest first, aligned with `days`. */
  nets: number[];
  /** Accessible balance at each day *boundary*, oldest first — `days.length + 1`
   *  values. Boundary `i` is the balance entering day `i`; boundary `i+1` its close,
   *  and their difference is `nets[i]` — the bar. The last is `currentWorth`. */
  worthBoundaries: number[];
  /** The monthly burn behind each projection, for the legend and tooltip. Null when
   *  there is nothing to project — no history, or (forecast) income covers spend. */
  forecastMonthly: number | null;
  emergencyMonthly: number | null;
  pessimisticMonthly: number | null;
  /** Months for each burn to deplete `currentWorth` to zero — the runway the dashed
   *  line spans. Null whenever the matching monthly figure is. */
  forecastMonths: number | null;
  emergencyMonths: number | null;
  pessimisticMonths: number | null;
};

/** Months to deplete `worth` at `monthlyBurn`, or null when it never depletes. */
function monthsToZero(worth: number, monthlyBurn: number | null): number | null {
  if (monthlyBurn === null || monthlyBurn <= 0 || worth <= 0) return null;
  return worth / monthlyBurn;
}

/**
 * The daily balance series for the dashboard chart. Takes the balance and spend
 * summaries the page has already loaded — the accessible figure the line anchors
 * to and the burns the projections run at — and adds only the one query the chart
 * needs of its own: net transaction flow bucketed by day, across all history.
 */
export async function getBalanceSeries(
  balances: BalanceSummary,
  spend: SpendSummary,
  now: Date = new Date(),
): Promise<BalanceSeries> {
  await connection();
  const db = await getDb();

  const display = await getDisplayCurrency();

  // The window spans from the earliest non-transfer transaction to now, in days,
  // capped. `periodWindow` counts back from today, so a count derived from the span
  // reaches the earliest day.
  const earliest = await db.transaction.aggregate({
    where: { type: { notIn: ["TRANSFER"] }, transferGroupId: null },
    _min: { date: true },
  });
  const nowMs = now.getTime();
  const spanDays = earliest._min.date
    ? Math.ceil((nowMs - earliest._min.date.getTime()) / 86_400_000)
    : 1;
  const count = Math.min(MAX_DAYS, Math.max(1, spanDays) + 1);
  const days = periodWindow(now, "day", count);

  const rows = await db.transaction.findMany({
    where: {
      date: { gte: periodStart(days[0], "day") },
      // The same transfer exclusion as the comparison/net metrics: Akahu's tagged
      // type and any leg a user linked by hand. A day's flow equals that net.
      type: { notIn: ["TRANSFER"] },
      transferGroupId: null,
    },
    select: {
      date: true,
      amount: true,
      account: { select: { currency: true } },
    },
  });

  // Each foreign row counts at the rate on its own day, the rule every mixed-
  // currency figure on the dashboard is valued by.
  const toDisplay = await displayConverter(display, rows.map((r) => r.account.currency));

  const window = new Set(days);
  const netByKey = new Map<string, number>(days.map((k) => [k, 0]));
  for (const row of rows) {
    const key = periodKey(row.date, "day");
    if (!window.has(key)) continue;
    netByKey.set(
      key,
      netByKey.get(key)! + toDisplay(money(row.amount), row.account.currency, row.date),
    );
  }

  const nets = days.map((k) => netByKey.get(k)!);

  // Worth is known at the right edge (today's accessible figure) and walked
  // backward: the worth entering a day is its close less that day's flow.
  const currentWorth = balances.accessible;
  const worthBoundaries = new Array<number>(nets.length + 1);
  worthBoundaries[nets.length] = currentWorth;
  for (let k = nets.length - 1; k >= 0; k--) worthBoundaries[k] = worthBoundaries[k + 1] - nets[k];

  // Forecast net burn: the "life goes on" spend less the periodic income forecast
  // to keep covering part of it — the same net burn the forecast runway tile uses.
  // Emergency burn: essentials only, no income offset, the floor spending is cut
  // to. Both deplete the accessible figure to zero.
  const forecastMonthly =
    spend.forecastBurn === null ? null : spend.forecastBurn - spend.forecastIncome;
  const pessimisticMonthly =
    spend.forecastBurn === null ? null : spend.forecastBurn;
  const emergencyMonthly = spend.medianEssential;

  return {
    displayCurrency: display,
    now: nowMs,
    currentWorth,
    days,
    nets,
    worthBoundaries,
    forecastMonthly,
    emergencyMonthly,
    pessimisticMonthly,
    forecastMonths: monthsToZero(currentWorth, forecastMonthly),
    emergencyMonths: monthsToZero(currentWorth, emergencyMonthly),
    pessimisticMonths: monthsToZero(currentWorth, pessimisticMonthly),
  };
}
