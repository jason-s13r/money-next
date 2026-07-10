import Link from "next/link";
import type { Comparison, PeriodBreakdown } from "@/lib/metrics";
import { netOf, netRange, UNCATEGORISED, UNKNOWN_MERCHANT } from "@/lib/metrics";
import { isKnownGroup } from "@/lib/categories";
import { slugify } from "@/lib/slug";
import { formatDate, formatMoneyWhole } from "@/lib/format";
import { formatPeriodKey, formatPeriodShort, PERIODS, type Period } from "@/lib/periods";
import { CELL, CHEVRON, HEAD, Swatch } from "./table";
import { SpendRow, type SpendNode } from "./spend-row";

// Income and spending, per period, on one shared value axis.
//
// Not nested donut rings: two concentric rings have different circumferences, so
// the same angle means a different amount of money on each. The reader cannot
// answer "did I spend more than I earned" by eye — the very question the chart
// exists for. Two bars on one axis answer it by length.
//
// The two bars carry different measures, so each has its own legend and its own
// slot ordering. Identity is read within a row, never across the two.

/**
 * Where a spending row leads. Only real NZFCC groups have a page: "Other" is an
 * aggregate this chart invented and has nowhere to go, and "Uncategorised" is the
 * absence of a category, which gets its own list.
 */
function rowHref(category: string): string | null {
  if (category === UNCATEGORISED) return "/categories/uncategorised";
  return isKnownGroup(category) ? `/categories/${slugify(category)}` : null;
}

/**
 * A disclosure row leads to its subcategory — except under "Other", whose rows
 * are whole groups rather than subcategories, and lead to the group's own page.
 */
function detailHref(category: string, label: string): string | null {
  if (isKnownGroup(category)) return `/categories/${slugify(category)}/${slugify(label)}`;
  return isKnownGroup(label) ? `/categories/${slugify(label)}` : null;
}

/**
 * The tree under one spending category: its subcategories, and their merchants.
 *
 * A merchant's page holds *all* its transactions, not only the ones under the
 * category the reader opened — that is what a merchant page is. Only a merchant
 * enrichment failed to name has nowhere to go.
 */
function spendNode(comparison: Comparison, category: string): SpendNode {
  const { periods, spendCategories, spendSubcategories, spendMerchants } = comparison;
  const merchantsOf = spendMerchants.get(category);

  return {
    label: category,
    color: slotColor(spendCategories, category),
    href: rowHref(category),
    values: periods.map((p) => p.spend.get(category) ?? 0),
    children: (spendSubcategories.get(category) ?? []).map((label) => ({
      label,
      href: detailHref(category, label),
      values: periods.map((p) => p.spendDetail.get(category)?.get(label)?.total ?? 0),
      children: (merchantsOf?.get(label) ?? []).map((merchant) => ({
        label: merchant,
        href: merchant === UNKNOWN_MERCHANT ? null : `/merchants/${slugify(merchant)}`,
        values: periods.map(
          (p) => p.spendDetail.get(category)?.get(label)?.merchants.get(merchant) ?? 0,
        ),
        children: [],
      })),
    })),
  };
}

/** Colour follows the entity: a category keeps its slot in every period. */
function slotColor(categories: string[], category: string): string {
  // Not a categorical entity — the absence of one. Grey, never a slot.
  if (category === UNCATEGORISED) return "var(--viz-unknown)";
  const index = categories.indexOf(category);
  return `var(--viz-${(index % 8) + 1})`;
}

function Legend({ title, categories }: { title: string; categories: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      <span className="text-muted">{title}</span>
      {categories.map((category) => (
        // Text wears an ink token; the swatch beside it carries the identity.
        <span key={category} className="flex items-center gap-1.5 text-secondary">
          <Swatch color={slotColor(categories, category)} />
          {category}
        </span>
      ))}
    </div>
  );
}

/**
 * One stacked bar on the shared axis. Segments are separated by a 2px gap in the
 * surface colour rather than a border: a stroke would add ink that isn't data.
 *
 * The bar sits in a faint full-width track so that a period with no income reads
 * as *zero* rather than as a missing row.
 */
function StackedBar({
  segments,
  categories,
  max,
}: {
  segments: [string, number][];
  categories: string[];
  max: number;
}) {
  const total = segments.reduce((sum, [, value]) => sum + value, 0);

  return (
    <div className="h-4 w-full rounded-[2px] bg-current/5">
      <div className="flex h-full gap-[2px]" style={{ width: `${(total / max) * 100}%` }}>
        {segments.map(([category, value]) => (
          <div
            key={category}
            // A segment worth a rounding error still owns a legend entry, so give
            // it a floor rather than letting it disappear into a sub-pixel width.
            className="h-full min-w-[2px] first:rounded-l-[2px] last:rounded-r-[4px]"
            style={{
              width: `${(value / total) * 100}%`,
              backgroundColor: slotColor(categories, category),
            }}
            title={`${category}: ${formatMoneyWhole(value)}`}
          />
        ))}
      </div>
    </div>
  );
}

function segmentsFor(bucket: Map<string, number>, order: string[]): [string, number][] {
  return order
    .filter((category) => (bucket.get(category) ?? 0) > 0)
    .map((category) => [category, bucket.get(category)!]);
}

function PeriodCard({
  breakdown,
  comparison,
}: {
  breakdown: PeriodBreakdown;
  comparison: Comparison;
}) {
  const { incomeCategories, spendCategories, period } = comparison;
  const max = Math.max(breakdown.incomeTotal, breakdown.spendTotal);
  const net = netOf(breakdown);
  const [netLow, netHigh] = netRange(breakdown);
  const defaulted = breakdown.defaultedIn + breakdown.defaultedOut;

  return (
    <div className="rounded-lg border border-current/10 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-baseline gap-2 text-sm font-medium">
          {formatPeriodKey(breakdown.key, period)}
          {breakdown.partial ? (
            // A period in progress is short by construction. Say so on the card
            // rather than letting a half-finished bar read as a spending drop.
            <span className="rounded-sm bg-current/10 px-1.5 py-0.5 text-xs font-normal text-secondary">
              partial
            </span>
          ) : null}
        </p>
        <p className="text-sm">
          <span className="text-muted">net </span>
          <span
            className={`font-mono tabular-nums ${
              net >= 0 ? "text-status-good" : "text-status-critical"
            }`}
          >
            {net >= 0 ? "+" : "−"}
            {formatMoneyWhole(Math.abs(net))}
          </span>
        </p>
      </div>

      <div className="mt-3 space-y-2">
        {(
          [
            ["Income", breakdown.income, incomeCategories, breakdown.incomeTotal],
            ["Spend", breakdown.spend, spendCategories, breakdown.spendTotal],
          ] as const
        ).map(([label, bucket, order, total]) => (
          <div key={label} className="grid grid-cols-[3.5rem_1fr_5.5rem] items-center gap-3">
            <span className="text-xs text-secondary">{label}</span>
            <StackedBar
              segments={segmentsFor(bucket, [...order])}
              categories={[...order]}
              max={max}
            />
            <span className="text-right font-mono text-xs tabular-nums text-secondary">
              {formatMoneyWhole(total)}
            </span>
          </div>
        ))}
      </div>

      {defaulted > 0 ? (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted">
          <span className="mt-1">
            <Swatch color="var(--viz-unknown)" />
          </span>
          <span>
            {formatMoneyWhole(defaulted)} bucketed by direction only — if any of it is an internal
            transfer, net lands between {formatMoneyWhole(netLow)} and {formatMoneyWhole(netHigh)}.
          </span>
        </p>
      ) : null}
    </div>
  );
}

function PeriodSelector({ period, count }: { period: Period; count: number }) {
  return (
    // One filter row above everything it scopes, never inside a chart card.
    <nav className="flex flex-wrap items-center gap-1 text-sm">
      <span className="mr-2 text-muted">Compare by</span>
      {PERIODS.map((option) => (
        <Link
          key={option}
          href={`/?period=${option}&n=${count}`}
          aria-current={option === period ? "page" : undefined}
          className={`rounded-md px-2.5 py-1 capitalize ${
            option === period
              ? "bg-foreground text-background"
              : "text-secondary hover:bg-current/5"
          }`}
        >
          {option}
        </Link>
      ))}
      <span className="mx-2 text-muted">·</span>
      {[3, 6, 12].map((option) => (
        <Link
          key={option}
          href={`/?period=${period}&n=${option}`}
          aria-current={option === count ? "page" : undefined}
          className={`rounded-md px-2.5 py-1 ${
            option === count ? "bg-foreground text-background" : "text-secondary hover:bg-current/5"
          }`}
        >
          {option}
        </Link>
      ))}
    </nav>
  );
}

/** The values behind every bar, for anyone the colours fail. */
function ComparisonTable({ comparison }: { comparison: Comparison }) {
  const { periods, incomeCategories, spendCategories, spendSubcategories, period } = comparison;
  const partialKey = periods.find((p) => p.partial)?.key;

  const row = (label: string, color: string | null, values: number[], emphasis = false) => (
    <tr key={label} className={emphasis ? "border-t border-current/20 font-medium" : ""}>
      <th scope="row" className="sticky left-0 bg-background px-3 py-1.5 text-left font-normal">
        <span className="flex items-center gap-2">
          {/* Holds the column the spending rows' chevrons occupy. */}
          <span className={CHEVRON} />
          {color ? <Swatch color={color} /> : <span className="size-2.5 shrink-0" />}
          {label}
        </span>
      </th>
      {values.map((value, i) => (
        <td key={i} className={CELL}>
          {value === 0 ? <span className="text-muted">—</span> : formatMoneyWhole(value)}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-3xl text-sm">
        <thead>
          <tr className="border-b border-current/20">
            <th scope="col" className="sticky left-0 bg-background px-3 py-2 text-left font-medium">
              Category
            </th>
            {periods.map((p) => (
              <th key={p.key} scope="col" className={HEAD}>
                {formatPeriodShort(p.key, period)}
                {p.key === partialKey ? <span className="text-muted"> *</span> : null}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          <tr>
            <th colSpan={periods.length + 1} scope="colgroup" className="px-3 pt-4 pb-1 text-left text-xs text-muted">
              Income
            </th>
          </tr>
          {incomeCategories.map((category) =>
            row(
              category,
              slotColor(incomeCategories, category),
              periods.map((p) => p.income.get(category) ?? 0),
            ),
          )}
          {row("Total income", null, periods.map((p) => p.incomeTotal), true)}

          <tr>
            <th colSpan={periods.length + 1} scope="colgroup" className="px-3 pt-4 pb-1 text-left text-xs text-muted">
              Spending
            </th>
          </tr>
          {spendCategories.map((category) => (
            <SpendRow key={category} row={spendNode(comparison, category)} />
          ))}
          {row("Total spending", null, periods.map((p) => p.spendTotal), true)}

          <tr className="border-t border-current/20 font-medium">
            <th scope="row" className="sticky left-0 bg-background px-3 py-2 text-left">
              <span className="flex items-center gap-2">
                <span className={CHEVRON} />
                <span className="size-2.5 shrink-0" />
                Net
              </span>
            </th>
            {periods.map((p) => {
              const net = netOf(p);
              return (
                <td
                  key={p.key}
                  className={`${CELL} ${net >= 0 ? "text-status-good" : "text-status-critical"}`}
                >
                  {net >= 0 ? "+" : "−"}
                  {formatMoneyWhole(Math.abs(net))}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function ComparisonSection({
  comparison,
  count,
}: {
  comparison: Comparison;
  count: number;
}) {
  const partial = comparison.periods.find((p) => p.partial);
  // "Through" is the newest transaction, not today: a stale sync and a fresh one
  // produce the same calendar month, and only this distinguishes them.
  const partialNote = partial
    ? `${formatPeriodKey(partial.key, comparison.period)} is still in progress — ${
        comparison.through
          ? `data runs through ${formatDate(comparison.through)}`
          : "no transactions in it yet"
      }.`
    : "";

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Income and spending</h2>
        <PeriodSelector period={comparison.period} count={count} />
      </div>

      <div className="mb-5 space-y-1.5">
        <Legend title="Income" categories={comparison.incomeCategories} />
        <Legend title="Spending" categories={comparison.spendCategories} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {comparison.periods.map((breakdown) => (
          <PeriodCard key={breakdown.key} breakdown={breakdown} comparison={comparison} />
        ))}
      </div>

      <p className="mt-3 text-xs text-muted">
        All bars share one axis, so a longer bar is more money — within a period and across them.
        {partial ? ` ${partialNote}` : ""}
      </p>

      <div className="mt-8">
        <h2 className="mb-3 text-sm font-medium">By category</h2>
        <ComparisonTable comparison={comparison} />
        {partial ? <p className="mt-2 text-xs text-muted">* {partialNote}</p> : null}
      </div>
    </section>
  );
}
