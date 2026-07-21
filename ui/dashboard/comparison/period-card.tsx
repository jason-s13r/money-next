import type { Comparison, PeriodBreakdown } from "@/lib/server/metrics/comparison";
import { netOf } from "@/lib/server/metrics/comparison";
import { formatMoneyWhole } from "@/lib/format";
import { formatPeriodKey } from "@/lib/periods";
import { slotColor } from "@/lib/server/metrics/comparison-nodes";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Net colour: green for a surplus period, red for a deficit. */
const netClass = (net: number) => (net >= 0 ? "text-status-good" : "text-status-critical");
/** A net figure with an explicit + or − sign and no cents. */
const signedWhole = (net: number) => `${net >= 0 ? "+" : "−"}${formatMoneyWhole(Math.abs(net))}`;

/**
 * One stacked bar on the shared axis. Segments are separated by a 2px gap in the
 * surface colour rather than a border: a stroke would add ink that isn't data.
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

export function PeriodCard({
  breakdown,
  comparison,
}: {
  breakdown: PeriodBreakdown;
  comparison: Comparison;
}) {
  const { incomeSubcategories, spendCategories, period } = comparison;
  const max = Math.max(breakdown.incomeTotal, breakdown.spendTotal);
  const net = netOf(breakdown);

  const incomeBySubcategory = new Map(
    [...breakdown.incomeDetail].map(([label, detail]) => [label, detail.total]),
  );

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-baseline gap-2">
          {formatPeriodKey(breakdown.key, period)}
          {breakdown.partial ? (
            <Badge variant="outline" className="font-normal text-secondary">
              partial
            </Badge>
          ) : null}
        </CardTitle>
        <CardAction className="text-sm">
          <span className="text-muted">net </span>
          <span className={`font-mono tabular-nums ${netClass(net)}`}>{signedWhole(net)}</span>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        {(
          [
            ["Income", incomeBySubcategory, incomeSubcategories, breakdown.incomeTotal],
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
      </CardContent>
    </Card>
  );
}
