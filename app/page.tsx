import { getLastSync } from "@/lib/server/data";
import { formatMoneyWhole } from "@/lib/format";
import { SyncStatus } from "@/ui/chrome/sync-status";
import { getBalanceSummary } from "@/lib/server/metrics/balance";
import { getReviewQueue, getSpendSummary } from "@/lib/server/metrics/spend";
import { forecastRunwayMonths, runwayMonths } from "@/lib/server/metrics/runway";
import { getComparison } from "@/lib/server/metrics/comparison";
import { isPeriod, offsetForStartDate, periodStart, periodWindow, type Period } from "@/lib/periods";
import { firstParam } from "@/lib/search-params";
import { Meter } from "@/ui/primitives/meter";
import { ComparisonCards, PeriodSelector } from "@/ui/dashboard/comparison";
import { CurrencyBreakdown } from "@/ui/dashboard/currency-breakdown";
import { ReviewBanner } from "@/ui/dashboard/review-banner";
import { Hero, StatTile, type Status } from "@/ui/primitives/stat-tile";

export const metadata = { title: "Financial health" };

const DEFAULT_PERIOD: Period = "month";
const WINDOW = 6;
const STEP = 3;

function parseWindow(searchParams: Record<string, string | string[] | undefined>, now: Date) {
  const rawPeriod = firstParam(searchParams.period);
  const rawFrom = firstParam(searchParams.from);

  const period = rawPeriod && isPeriod(rawPeriod) ? rawPeriod : DEFAULT_PERIOD;

  const from = rawFrom ? new Date(rawFrom) : null;
  const offset =
    from && !Number.isNaN(from.getTime()) ? offsetForStartDate(now, period, WINDOW, from) : 0;

  return { period, offset };
}

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

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Financial health</h1>
        <SyncStatus lastSync={lastSync} />
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
        <CurrencyBreakdown
          byCurrency={balances.byCurrency}
          displayCurrency={balances.displayCurrency}
        />
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
            label="Credit Facility"
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
      <ReviewBanner
        rows={review.rows}
        threshold={review.threshold}
        overThreshold={review.overThreshold}
        displayCurrency={balances.displayCurrency}
        unknownGroups={spend.unknownGroups}
      />

      <section className="mb-10">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium">Income and spending</h2>
        </div>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">

          <PeriodSelector period={period} href="/" />
          <a
            href={`/breakdown?period=${period}`}
            className="text-sm text-secondary hover:text-foreground"
          >
            Full breakdown →
          </a>
        </div>
        <ComparisonCards
          comparison={comparison}
          earlierHref={earlierHref}
          moreRecentHref={moreRecentHref}
        />
      </section>
    </main>
  );
}
