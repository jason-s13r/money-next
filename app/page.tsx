import Link from "next/link";
import { getLastSync } from "@/lib/data";
import { formatDateTime, formatMonthKey, formatMoneyWhole } from "@/lib/format";
import {
  forecastRunwayMonths,
  getBalanceSummary,
  getComparison,
  getReviewQueue,
  getSpendSummary,
  runwayMonths,
} from "@/lib/metrics";
import { isPeriod, offsetForStartDate, periodStart, periodWindow, type Period } from "@/lib/periods";
import { Meter } from "./_components/charts";
import { ComparisonSection } from "./_components/comparison";
import { Hero, StatTile, type Status } from "./_components/stat-tile";

export const metadata = { title: "Financial health" };

const DEFAULT_PERIOD: Period = "month";
/** Periods shown at once. Fixed: six reads as a trend without crowding the row. */
const WINDOW = 6;
/** Periods a page shifts by. Half the window, so consecutive pages overlap. */
const STEP = 3;

/**
 * `?period=` and `?from=` are user input; anything unexpected falls back.
 *
 * `from` is the start date of the oldest visible period — a time is a more
 * honest url than an opaque page number, and it snaps to the nearest window.
 * Absent, the window ends with the period in progress (offset 0).
 */
function parseWindow(searchParams: Record<string, string | string[] | undefined>, now: Date) {
  const rawPeriod = Array.isArray(searchParams.period) ? searchParams.period[0] : searchParams.period;
  const rawFrom = Array.isArray(searchParams.from) ? searchParams.from[0] : searchParams.from;

  const period = rawPeriod && isPeriod(rawPeriod) ? rawPeriod : DEFAULT_PERIOD;

  const from = rawFrom ? new Date(rawFrom) : null;
  const offset =
    from && !Number.isNaN(from.getTime()) ? offsetForStartDate(now, period, WINDOW, from) : 0;

  return { period, offset };
}

/** `Date` → `YYYY-MM-DD`. Period starts are UTC midnight, so this is exact. */
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/** Six months of essential spend in the bank is the conventional line. */
function runwayStatus(months: number): { status: Status; label: string } {
  if (months >= 6) return { status: "good", label: "Six months or more" };
  if (months >= 3) return { status: "warning", label: "Under six months" };
  return { status: "critical", label: "Under three months" };
}

export default async function DashboardPage(props: PageProps<"/">) {
  const now = new Date();
  const { period, offset } = parseWindow(await props.searchParams, now);

  const [balances, spend, comparison, review, lastSync] = await Promise.all([
    getBalanceSummary(),
    getSpendSummary(),
    getComparison(period, WINDOW, offset, now),
    getReviewQueue(),
    getLastSync(),
  ]);

  const runway = runwayMonths(balances, spend);
  const forecastRunway = forecastRunwayMonths(balances, spend);
  // Net monthly burn behind the forecast runway: what spending carries on costing,
  // less the periodic income (wages, a benefit) forecast to keep covering part of
  // it. The tile's note explains the runway from these two figures.
  const forecastIncome = spend.forecastIncome;
  const forecastNetBurn = spend.forecastBurn !== null ? spend.forecastBurn - forecastIncome : null;
  const money = (amount: number) => formatMoneyWhole(amount, balances.displayCurrency);
  // Whether any balance is held outside the display currency — the totals are only
  // "converted" when there is something to convert.
  const hasForeign = balances.byCurrency.some((b) => b.currency !== balances.displayCurrency);

  // The window pages by STEP periods, overlapping the last by half. Time runs
  // left-to-right, so "Earlier" steps the anchor back and "More recent" forward;
  // each link carries the start date of the window it lands on. A window ending
  // at the current period needs no `?from=`, keeping the dashboard's url clean.
  const base = `/?period=${period}`;
  const windowStart = (o: number) => periodStart(periodWindow(now, period, WINDOW, o)[0], period);
  const earlierHref = comparison.hasOlder
    ? `${base}&from=${isoDate(windowStart(offset + STEP))}`
    : null;
  const moreRecentHref =
    offset > 0
      ? offset - STEP <= 0
        ? base
        : `${base}&from=${isoDate(windowStart(offset - STEP))}`
      : null;

  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Financial health</h1>
        <p className="text-sm text-muted">
          {lastSync ? `Synced ${formatDateTime(lastSync.finishedAt)}` : "Never synced"}
        </p>
      </header>

      <section className="mb-8 flex items-start justify-between gap-4">
        <Hero
          label="Accessible net worth"
          value={formatMoneyWhole(balances.accessible, balances.displayCurrency)}
          note={`Excludes ${formatMoneyWhole(
            balances.locked,
            balances.displayCurrency,
          )} locked in KiwiSaver and investments.`}
        />
        {/* Multi-currency holdings, kept to a terse right-aligned indicator beside
            the headline rather than a full tile — the totals above already fold
            these into one number, so this is only a reminder of the spread. */}
        {hasForeign ? (
          <ul className="shrink-0 space-y-0.5 text-right text-xs font-mono tabular-nums">
            <li>Current Balances</li>
            {balances.byCurrency.map((b) => (
              <li key={b.currency}>
                <span className="text-secondary">{formatMoneyWhole(b.total, b.currency)}</span>
                {" "}
                <span className="text-muted">{b.currency}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label="Total net worth"
          value={formatMoneyWhole(balances.total, balances.displayCurrency)}
          note={
            hasForeign
              ? `All accounts, converted to ${balances.displayCurrency}`
              : `All accounts, in ${balances.displayCurrency}`
          }
        />
        <StatTile
          label="Liquid cash"
          value={formatMoneyWhole(balances.liquid, balances.displayCurrency)}
          note="Available in checking, savings, wallets"
        />
        <StatTile
          label="Locked away"
          value={formatMoneyWhole(balances.locked, balances.displayCurrency)}
          note="KiwiSaver and investments"
        />
      </section>

      {/* The two runways read as a pair: the emergency floor you could survive on
          with spending cut to essentials, beside the forecast if spending simply
          carries on — every category that recurs most months, one-off lumps like
          tax left out so they don't distort a typical month. The forecast nets off
          the periodic income (wages, a benefit, ongoing support) forecast to keep
          arriving, so it measures how long liquid savings must top up the shortfall
          — and reads "Sustained" when that income covers the burn outright. The
          credit facility rides along here: what it costs to keep going sits next to
          what could be drawn on to. */}
      <section
        className={`mb-8 grid items-start gap-4 ${
          balances.facility ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2"
        }`}
      >
        {runway !== null ? (
          <StatTile
            label="Emergency runway"
            value={`${runway.toFixed(1)} months`}
            status={runwayStatus(runway).status}
            statusLabel={runwayStatus(runway).label}
            note={`At ${formatMoneyWhole(
              spend.medianEssential!,
              balances.displayCurrency,
            )}/mo essential spend`}
          />
        ) : (
          <StatTile label="Emergency runway" value="—" note="Not enough spending history" />
        )}
        {forecastRunway !== null && forecastNetBurn !== null ? (
          forecastRunway === Infinity ? (
            <StatTile
              label="Forecasted runway"
              value="Sustained"
              status="good"
              statusLabel="Income covers spending"
              note="Periodic income covers forecast spending — no topups needed"
            />
          ) : (
            <StatTile
              label="Forecasted runway"
              value={`${forecastRunway.toFixed(1)} months`}
              status={runwayStatus(forecastRunway).status}
              statusLabel={runwayStatus(forecastRunway).label}
              note={
                forecastIncome > 0
                  ? `At ${money(forecastNetBurn)}/mo net spend`
                  : `At ${money(spend.forecastBurn!)}/mo if spending carries on unchanged`
              }
            />
          )
        ) : (
          <StatTile label="Forecasted runway" value="—" note="Not enough spending history" />
        )}
        {balances.facility ? (
          <Meter
            label="Credit facility drawn"
            fraction={balances.facility.utilisation}
            caption={`${formatMoneyWhole(
              balances.facility.drawn,
              balances.displayCurrency,
            )} drawn of ${formatMoneyWhole(
              balances.facility.limit,
              balances.displayCurrency,
            )} on ${balances.facility.name}. Undrawn credit is not counted as savings.`}
          />
        ) : null}
      </section>

      {/* Spending Akahu left without a category. Surfacing the count is the point:
          a total that admits how much of itself is still unaccounted for is more
          honest than one that quietly folds the remainder in. */}
      {review.rows > 0 ? (
        <section className="mb-8 rounded-lg border border-status-warning/40 bg-status-warning/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="inline-block size-2 shrink-0 rounded-full bg-status-warning" />
            <Link href="/categories/uncategorised" className="underline underline-offset-2">
              {review.rows.toLocaleString("en-NZ")} uncategorised transactions
            </Link>
          </p>
          {review.threshold !== null && review.overThreshold > 0 && review.overThreshold < review.rows ? (
            <p className="mt-1 text-sm text-secondary">
              {review.overThreshold === 1
                ? "One is"
                : `The largest ${review.overThreshold.toLocaleString("en-NZ")} are`}{" "}
              {formatMoneyWhole(review.threshold, balances.displayCurrency)} or more — worth
              categorising first.
            </p>
          ) : null}
          {spend.unknownGroups.length > 0 ? (
            <p className="mt-2 text-sm text-secondary">
              NZFCC returned {spend.unknownGroups.length} category group(s) this app doesn&apos;t
              know: {spend.unknownGroups.join(", ")}. They count as discretionary, which inflates
              the runway above. Add them to{" "}
              <code className="font-mono text-xs">lib/categories.ts</code>.
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="mb-10">
        <ComparisonSection
          comparison={comparison}
          earlierHref={earlierHref}
          moreRecentHref={moreRecentHref}
        />
      </div>
    </main>
  );
}
