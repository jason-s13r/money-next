import { RANGES } from "./balance-chart.util";

type LegendItem = { color: string; dashed?: boolean; label: string };

export function BalanceChartLegend({
  legend,
  rangeKey,
  onRangeChange,
}: {
  legend: LegendItem[];
  rangeKey: string;
  onRangeChange: (key: string) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-secondary">
        {legend.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5">
            {l.dashed ? (
              <span className="inline-block h-0 w-4 shrink-0 border-t-2 border-dashed" style={{ borderColor: l.color }} />
            ) : (
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: l.color }} />
            )}
            {l.label}
          </span>
        ))}
      </figcaption>
      {/* Zoom — how many days fill the width. Resolution stays one day. */}
      <div className="flex gap-1 text-xs">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => onRangeChange(r.key)}
            aria-pressed={r.key === rangeKey}
            className={`rounded-md px-2 py-1 ${
              r.key === rangeKey ? "bg-foreground text-background" : "text-secondary hover:bg-current/5"
            }`}
          >
            {r.key}
          </button>
        ))}
      </div>
    </div>
  );
}
