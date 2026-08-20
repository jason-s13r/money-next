import {
  isPeriod,
  offsetForStartDate,
  periodStart,
  periodWindow,
  type Period,
} from "@/lib/periods";
import { firstParam } from "@/lib/search-params";
import {
  baseWithActiveLayers,
  budgetsInWindow,
  getBudgetVsActual,
  isBudgetView,
  type BudgetView,
} from "@/lib/server/metrics/budget";
import { getTaxYear } from "@/lib/server/queries/tax-year";
import { Link } from "@/ui/chrome/workspace-context";
import { ComparisonTable } from "@/ui/dashboard/comparison/table";
import { WindowPager } from "@/ui/dashboard/comparison/pager";
import { PeriodSelector } from "@/ui/dashboard/comparison/selector";
import { BudgetSelector, ViewSelector } from "./selectors";
import { connection } from "next/server";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

// Budget against reality, in the table the historic breakdown already uses.
//
// Same window machinery as /breakdown — same WINDOW, STEP and parsing — so the
// two pages page in step and a reader moving between them keeps their place.

export const metadata = { title: "Budget vs actual" };

const DEFAULT_PERIOD: Period = "month";
const WINDOW = 6;
const STEP = 3;

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export default async function BudgetBreakdownPage(
  props: PageProps<"/w/[workspace]/budgets/breakdown">,
) {
  // TODO: Cache Components adoption. Added to unblock the build: remove this connection() to re-trigger the error and review the fix options.
  await connection();
  const now = new Date();
  const searchParams = await props.searchParams;

  const rawPeriod = firstParam(searchParams.period);
  const period = rawPeriod && isPeriod(rawPeriod) ? rawPeriod : DEFAULT_PERIOD;

  // Read before the window is parsed: snapping `?from=` onto a tax-year window
  // needs to know where the household's year starts.
  const taxYear = await getTaxYear();

  const rawFrom = firstParam(searchParams.from);
  const from = rawFrom ? new Date(rawFrom) : null;
  const offset =
    from && !Number.isNaN(from.getTime())
      ? offsetForStartDate(now, period, WINDOW, from, taxYear)
      : 0;

  const rawView = firstParam(searchParams.view);
  const view: BudgetView = rawView && isBudgetView(rawView) ? rawView : "budget";

  // Which base to show. The view is anchored on one base and layers in that base's
  // own date-active layers — no arbitrary cross-budget selection any more. No
  // `?base=` means the first base in range, since a reader who has not chosen wants
  // to see a plan rather than none of it.
  const wantedBase = firstParam(searchParams.base);

  // The bases in range are needed *before* the comparison can be built, since the
  // chosen one decides what it layers. Asked for on their own rather than by
  // building a throwaway comparison first — that would run the whole historic
  // aggregation twice for every page load, to learn a list of names.
  //
  // The id from the URL is resolved against this list rather than trusted, so an
  // unknown one falls back to the first base.
  const available = await budgetsInWindow(period, WINDOW, offset, now);
  const base = available.find((b) => b.id === wantedBase) ?? available[0] ?? null;

  // The base plus the layers of it live in this window — the ids the view sums.
  const selectedIds = base
    ? await baseWithActiveLayers(base.id, period, WINDOW, offset, now)
    : [];

  const data = await getBudgetVsActual(selectedIds, period, WINDOW, offset, now);

  const shown =
    view === "actual" ? data.actual : view === "budget" ? data.budget : data.variance;

  // Every link keeps the rest of the query intact, so switching one filter never
  // silently resets another.
  const query = (over: { view?: BudgetView; base?: string; from?: string | null }) => {
    const params = new URLSearchParams();
    params.set("period", period);
    params.set("view", over.view ?? view);

    const chosen = over.base ?? base?.id;
    if (chosen) params.set("base", chosen);

    const start = over.from === undefined ? rawFrom : over.from;
    if (start) params.set("from", start);

    return `/budgets/breakdown?${params}`;
  };

  const windowStart = (o: number) =>
    periodStart(periodWindow(now, period, WINDOW, o, taxYear)[0], period, taxYear);
  const earlierHref = data.actual.hasOlder
    ? query({ from: isoDate(windowStart(offset + STEP)) })
    : null;
  const moreRecentHref =
    offset > 0
      ? query({ from: offset - STEP <= 0 ? null : isoDate(windowStart(offset - STEP)) })
      : null;

  return (
    <main className="mx-auto mb-10 w-full max-w-5xl p-2">
      <h1 className="sr-only">Budget vs actual</h1>

      <div className="flex flex-col gap-2">
        <PeriodSelector period={period} href="/budgets/breakdown" />
        <ViewSelector view={view} href={(option) => query({ view: option })} />
        <BudgetSelector
          available={available}
          selectedId={base?.id ?? null}
          href={(b) => query({ base: b.id })}
        />
      </div>

      {available.length === 0 ? (
        <p className="py-10 text-center text-sm opacity-60">
          No budgets cover this window.{" "}
          <Link href="/budgets/new" className="underline">
            Make one
          </Link>{" "}
          and its figures will appear beside what actually happened.
        </p>
      ) : (
        <>
          <p className="mt-4 text-xs text-muted">
            {view === "budget"
              ? "What this base plans for, with its seasonal layers added on while their windows are live."
              : view === "actual"
                ? "What actually happened, from your transactions."
                : "Actual minus budget. Under the Spending block, a plus is an overspend; under Income, a plus is more than you planned for."}
          </p>

          <div className="mt-4">
            <ComparisonTable comparison={shown} format={view === "variance" ? "variance" : "money"} />
          </div>

          <div className="mt-4">
            <WindowPager earlierHref={earlierHref} moreRecentHref={moreRecentHref} />
          </div>
        </>
      )}
    </main>
  );
}
