import { getComparison } from "@/lib/server/metrics/comparison";
import { isPeriod, offsetForStartDate, periodStart, periodWindow, type Period } from "@/lib/periods";
import { firstParam } from "@/lib/search-params";
import { ComparisonSection } from "@/ui/dashboard/comparison";
import { PeriodSelector } from "@/ui/dashboard/comparison/selector";
import { connection } from "next/server";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata = { title: "Income and spending" };

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

export default async function BreakdownPage(props: PageProps<"/w/[workspace]/breakdown">) {
  // TODO: Cache Components adoption. Added to unblock the build: remove this connection() to re-trigger the error and review the fix options.
  await connection();
  const now = new Date();
  const { period, offset } = parseWindow(await props.searchParams, now);

  const comparison = await getComparison(period, WINDOW, offset, now);

  const base = `/breakdown?period=${period}`;
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
    <main className="mx-auto mb-10 w-full max-w-5xl p-2">
      <h1 className="sr-only">Income and spending</h1>

      <PeriodSelector period={period} href="/breakdown" />
      <ComparisonSection
        comparison={comparison}
        earlierHref={earlierHref}
        moreRecentHref={moreRecentHref}
      />
    </main>
  );
}
