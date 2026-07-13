import Link from "next/link";
import { getLastSync } from "@/lib/data";
import { formatDateTime, formatMonthKey, formatMoneyWhole } from "@/lib/format";
import {
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
          {lastSync ? `Synced ${formatDateTime(lastSync.finishedAt)}` : "Never synced"} ·{" "}
          <Link href="/transactions/search" className="underline underline-offset-2">
            Search
          </Link>{" "}
          ·{" "}
          <Link href="/accounts" className="underline underline-offset-2">
            Accounts
          </Link>
        </p>
      </header>

      <section className="mb-8">
        <Hero
          label="Accessible net worth"
          value={formatMoneyWhole(balances.accessibleNzd)}
          note={`Excludes ${formatMoneyWhole(balances.locked)} locked in KiwiSaver and investments.`}
        />
      </section>

      <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Total net worth"
          value={formatMoneyWhole(balances.totalNzd)}
          note="NZD accounts only"
        />
        <StatTile
          label="Liquid cash"
          value={formatMoneyWhole(balances.liquid)}
          note="Available in checking, savings, wallets"
        />
        <StatTile
          label="Locked away"
          value={formatMoneyWhole(balances.locked)}
          note="KiwiSaver and investments"
        />
        {runway !== null ? (
          <StatTile
            label="Emergency runway"
            value={`${runway.toFixed(1)} months`}
            status={runwayStatus(runway).status}
            statusLabel={runwayStatus(runway).label}
            note={`At ${formatMoneyWhole(spend.medianEssential!)}/mo essential spend`}
          />
        ) : (
          <StatTile label="Emergency runway" value="—" note="Not enough spending history" />
        )}
      </section>

      {balances.facility ? (
        <section className="mb-8 grid items-start gap-4 sm:grid-cols-2">
          <Meter
            label="Credit facility drawn"
            fraction={balances.facility.utilisation}
            caption={`${formatMoneyWhole(balances.facility.drawn)} drawn of ${formatMoneyWhole(
              balances.facility.limit,
            )} on ${balances.facility.name}. Undrawn credit is not counted as savings.`}
          />
          {balances.foreign.length > 0 ? (
            <div className="rounded-lg border border-current/10 p-4">
              <p className="text-sm text-secondary">Foreign balances</p>
              <ul className="mt-2 space-y-1">
                {balances.foreign.map((f) => (
                  <li key={f.currency} className="flex justify-between text-sm">
                    <span className="text-secondary">{f.currency}</span>
                    <span className="font-mono tabular-nums">
                      {formatMoneyWhole(f.total, f.currency)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                Not included in the totals above — there are no exchange rates yet.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Spending Akahu left without a category. Surfacing the count is the point:
          a total that admits how much of itself is still unaccounted for is more
          honest than one that quietly folds the remainder in. */}
      {review.rows > 0 ? (
        <section className="mb-8 rounded-lg border border-status-warning/40 bg-status-warning/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="inline-block size-2 shrink-0 rounded-full bg-status-warning" />
            {review.rows.toLocaleString("en-NZ")} uncategorised transactions
          </p>
          <p className="mt-1 text-sm text-secondary">
            {formatMoneyWhole(review.outflow)} of spending has no category and is shown in grey.
            Only {review.overThreshold} are over $500 — those are the ones worth categorising first.
          </p>
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
