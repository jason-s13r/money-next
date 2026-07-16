import type { Comparison } from "@/lib/server/metrics/comparison";
import { PeriodCard } from "./period-card";
import { ComparisonTable } from "./table";
import { WindowPager } from "./pager";

// Income and spending, per period, on one shared value axis.
//
// Not nested donut rings: two concentric rings have different circumferences, so
// the same angle means a different amount of money on each. The reader cannot
// answer "did I spend more than I earned" by eye — the very question the chart
// exists for. Two bars on one axis answer it by length.
//
// The two bars carry different measures, so each has its own legend and its own
// slot ordering. Identity is read within a row, never across the two.
//
// Cards, table, pager, and period selector are split into sibling files so this
// index file is just the public layout components.

export function ComparisonCards({
  comparison,
  earlierHref,
  moreRecentHref,
}: {
  comparison: Comparison;
  earlierHref: string | null;
  moreRecentHref: string | null;
}) {
  // A period with no money either way is a $0 card that carries nothing — skip it.
  const cardPeriods = comparison.periods.filter((p) => p.incomeTotal > 0 || p.spendTotal > 0);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cardPeriods.map((breakdown) => (
          <PeriodCard key={breakdown.key} breakdown={breakdown} comparison={comparison} />
        ))}
      </div>

      <div className="mt-4">
        <WindowPager earlierHref={earlierHref} moreRecentHref={moreRecentHref} />
      </div>
    </>
  );
}

export function ComparisonSection({
  comparison,
  earlierHref,
  moreRecentHref,
}: {
  comparison: Comparison;
  earlierHref: string | null;
  moreRecentHref: string | null;
}) {
  return (
    <section>
      <div className="mt-4">
        <ComparisonCards
          comparison={comparison}
          earlierHref={earlierHref}
          moreRecentHref={moreRecentHref}
        />
      </div>

      <div className="mt-8">
        <ComparisonTable comparison={comparison} />
      </div>
    </section>
  );
}
