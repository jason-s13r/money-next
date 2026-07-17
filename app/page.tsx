import { getLastSync } from "@/lib/server/queries/runs";
import { formatMoneyWhole } from "@/lib/format";
import { SyncStatus } from "@/ui/chrome/sync-status";
import { getBalanceSummary } from "@/lib/server/metrics/balance";
import { getReviewQueue, getSpendSummary } from "@/lib/server/metrics/spend";
import { getRunways } from "@/lib/server/metrics/runway";
import { getComparison } from "@/lib/server/metrics/comparison";
import { getBalanceSeries } from "@/lib/server/metrics/balance-series";
import { isPeriod, offsetForStartDate, periodStart, periodWindow, type Period } from "@/lib/periods";
import { firstParam } from "@/lib/search-params";
import { ComparisonCards } from "@/ui/dashboard/comparison";
import { PeriodSelector } from "@/ui/dashboard/comparison/selector";
import { CurrencyBreakdown } from "@/ui/dashboard/currency-breakdown";
import { ReviewBanner } from "@/ui/dashboard/review-banner";
import { BalanceChart } from "@/ui/dashboard/balance-chart";
import { Hero } from "@/ui/primitives/stat-tile";

export const metadata = { title: "Financial health" };

const DEFAULT_PERIOD: Period = "month";
const WINDOW = 3;
const STEP = 3;

function parseWindow(searchParams: Record<string, string | string[] | undefined>, now: Date) {
  const rawPeriod = firstParam(searchParams.period);
  const rawFrom = firstParam(searchParams.from);

  const period = rawPeriod && isPeriod(rawPeriod) ? rawPeriod : DEFAULT_PERIOD;

  const from = rawFrom ? new Date(rawFrom) : null;
  const offset = from && !Number.isNaN(from.getTime()) ? offsetForStartDate(now, period, WINDOW, from) : 0;

  return { period, offset };
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

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

  const base = `/breakdown?period=${period}`;
  const windowStart = (o: number) => periodStart(periodWindow(now, period, WINDOW, o)[0], period);
  const earlierHref = comparison.hasOlder ? `${base}&from=${isoDate(windowStart(offset + STEP))}` : null;
  const moreRecentHref =
    offset > 0 ? (offset - STEP <= 0 ? base : `${base}&from=${isoDate(windowStart(offset - STEP))}`) : null;

  // The net-worth-over-time chart reuses the balances and spend already loaded
  // above: the accessible figure its line anchors to, and the burns its three
  // projections run at. Its own query is just the per-day net flow, over all
  // history — the chart is always daily and scrolls/zooms on the client.
  const series = await getBalanceSeries(balances, spend, now);

  // Runway scenarios are built outside JSX so the Hero component receives plain
  // strings and colour tokens rather than inline templates.
  const money = (amount: number) => formatMoneyWhole(amount, balances.displayCurrency);
  const runways = getRunways(balances, spend, money);

  return (
    <main className="mx-auto w-full max-w-5xl p-2 flex gap-6 flex-col">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Financial health</h1>
        <SyncStatus lastSync={lastSync} />
      </header>

      <section className="flex items-start justify-between gap-4">
        <Hero
          label="Available Balance"
          value={formatMoneyWhole(balances.accessible, balances.displayCurrency)}
          note={`Excludes ${formatMoneyWhole(
            balances.locked,
            balances.displayCurrency,
          )} locked in KiwiSaver and investments.`}
          runways={runways}
        />
        <CurrencyBreakdown byCurrency={balances.byCurrency} displayCurrency={balances.displayCurrency} />
      </section>

      {/* Spending Akahu left without a category. Surfacing the count is the point:
          a total that admits how much of itself is still unaccounted for is more
          honest than one that quietly folds the remainder in. */}
      <ReviewBanner
        rows={review.rows}
        threshold={review.threshold}
        overThreshold={review.overThreshold}
        displayCurrency={balances.displayCurrency}
      />

      {/* Balance over time. The line is the accessible balance reconstructed from
          the transaction flow (BalanceSnapshot history is only days old); the bars
          are each day's net flow — the line's own deltas — and the two dashed
          lines project the emergency and forecast burns named in the tiles above
          out to where the money runs out. */}
      <BalanceChart series={series} />

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
          <PeriodSelector period={period} href="/" />
          <a href={`/breakdown?period=${period}`} className="text-sm text-secondary hover:text-foreground">
            Full breakdown →
          </a>
        </div>
        <ComparisonCards comparison={comparison} earlierHref={earlierHref} moreRecentHref={moreRecentHref} />
      </section>
    </main>
  );
}
