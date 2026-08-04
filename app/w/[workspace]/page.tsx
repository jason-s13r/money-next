import { formatMoneyWhole } from "@/lib/format";
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
import { Link } from "@/ui/chrome/workspace-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Dashboard" };

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

export default async function DashboardPage(props: PageProps<"/w/[workspace]">) {
  const now = new Date();
  const { period, offset } = parseWindow(await props.searchParams, now);

  const [balances, spend, comparison, review] = await Promise.all([
    getBalanceSummary(),
    getSpendSummary(),
    getComparison(period, WINDOW, offset, now),
    getReviewQueue(),
  ]);

  const base = `/breakdown?period=${period}`;
  const windowStart = (o: number) => periodStart(periodWindow(now, period, WINDOW, o)[0], period);
  const earlierHref = comparison.hasOlder ? `${base}&from=${isoDate(windowStart(offset + STEP))}` : null;
  const moreRecentHref =
    offset > 0 ? (offset - STEP <= 0 ? base : `${base}&from=${isoDate(windowStart(offset - STEP))}`) : null;

  // The net-worth-over-time chart reuses the balances and spend already loaded
  // above: the accessible figure its line anchors to, and the history-derived
  // rates its projections fall back on. Its own queries are the per-day net flow
  // over all history, and the forecast scenarios to walk forward.
  const series = await getBalanceSeries(balances, spend, now);

  // The runway tiles read off the very same projections the chart draws, so a
  // tile can never disagree with the line above it. Built outside JSX so Hero
  // receives plain strings and colour tokens rather than inline templates.
  const money = (amount: number) => formatMoneyWhole(amount, balances.displayCurrency);
  const runways = getRunways(series.scenarios, money);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-3 py-5 sm:px-6 sm:py-8">
      <h1 className="sr-only">Dashboard</h1>

      <Card>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
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
        </CardContent>
      </Card>

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
          are each day's net flow — the line's own deltas — and each dashed line
          walks one forecast budget forward to where the money runs out, carrying
          on under the axis into any credit facility until that is spent too. */}
      <Card>
        <CardHeader>
          <CardTitle>Balance over time</CardTitle>
        </CardHeader>
        <CardContent>
          <BalanceChart series={series} />
          {/* Said plainly rather than silently: with no forecast budget there is no
              forward line at all. Nothing here creates one — a page that
              bootstrapped a plan on render would put figures in front of someone
              they never agreed to. */}
          {!series.scenariosConfigured ? (
            <p className="mt-3 text-xs text-muted">
              No forecast budget yet, so the chart stops at today.{" "}
              <Link href="/budgets" className="underline underline-offset-2 hover:text-foreground">
                Mark a budget as a forecast
              </Link>{" "}
              to project it forward day by day.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
          <PeriodSelector period={period} href="/" />
          <Link href={base} className="text-sm text-secondary hover:text-foreground">
            Full breakdown →
          </Link>
        </div>
        <ComparisonCards comparison={comparison} earlierHref={earlierHref} moreRecentHref={moreRecentHref} />
      </section>
    </main>
  );
}
