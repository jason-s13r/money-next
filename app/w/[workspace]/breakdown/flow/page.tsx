import { getComparison } from "@/lib/server/metrics/comparison";
import { flowSankey } from "@/lib/server/metrics/comparison/sankey";
import {
  formatPeriodKey,
  isPeriod,
  offsetForStartDate,
  periodStart,
  periodWindow,
  type Period,
} from "@/lib/periods";
import { firstParam } from "@/lib/search-params";
import { PeriodSelector } from "@/ui/dashboard/comparison/selector";
import { SankeySection } from "@/ui/dashboard/sankey-section";
import { getBalanceSummary } from "@/lib/server/metrics/balance";
import { WindowPager } from "@/ui/dashboard/comparison/pager";

export const metadata = { title: "Income and spending breakdown" };

const DEFAULT_PERIOD: Period = "month";
const WINDOW = 1;
const STEP = 1;

function parseWindow(searchParams: Record<string, string | string[] | undefined>, now: Date) {
  const rawPeriod = firstParam(searchParams.period);
  const rawFrom = firstParam(searchParams.from);

  const period = rawPeriod && isPeriod(rawPeriod) ? rawPeriod : DEFAULT_PERIOD;

  const from = rawFrom ? new Date(rawFrom) : null;
  const offset = from && !Number.isNaN(from.getTime()) ? offsetForStartDate(now, period, WINDOW, from) : 0;

  return { period, offset };
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export default async function BreakdownFlowPage(props: PageProps<"/w/[workspace]/breakdown/flow">) {
  const now = new Date();
  const { period, offset } = parseWindow(await props.searchParams, now);

  const [comparison, balances] = await Promise.all([getComparison(period, WINDOW, offset, now), getBalanceSummary()]);

  // Built here rather than in the client section: the diagram is a small fraction
  // of the Comparison it is derived from, and this way only the diagram crosses.
  const sankeyPeriods = comparison.periods.map((p, i) => ({
    key: p.key,
    label: formatPeriodKey(p.key, comparison.period),
    data: flowSankey(comparison, i),
  }));

  const base = `/breakdown/flow?period=${period}`;
  const windowStart = (o: number) => periodStart(periodWindow(now, period, WINDOW, o)[0], period);
  const earlierHref = comparison.hasOlder ? `${base}&from=${isoDate(windowStart(offset + STEP))}` : null;
  const moreRecentHref =
    offset > 0 ? (offset - STEP <= 0 ? base : `${base}&from=${isoDate(windowStart(offset - STEP))}`) : null;

  return (
    <main className="mx-auto mb-10 w-full flex flex-col gap-4 max-w-5xl p-2">
      <header>
        <h1 className="text-2xl font-semibold">Money Flow</h1>
      </header>

      <PeriodSelector period={period} href="/breakdown/flow" />
      
      <SankeySection periods={sankeyPeriods} displayCurrency={balances.displayCurrency} />

      <WindowPager earlierHref={earlierHref} moreRecentHref={moreRecentHref} />
    </main>
  );
}
