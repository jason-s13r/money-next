import { formatMonthKey, formatMonthShort, formatMoneyWhole } from "@/lib/format";

// Charts are plain HTML marks, not SVG: they stay responsive without measuring,
// and there is one series in each, so no categorical palette is in play.
//
// Mark specs follow the house data-viz rules — bars capped at 24px so the band
// keeps its air, a 4px rounded data-end squared off at the baseline, hairline
// recessive gridlines, and text in ink tokens rather than the series colour.

/** Every chart carries a table twin, so no value is reachable only by hovering. */
function TableView({
  columns,
  rows,
}: {
  columns: [string, string];
  rows: { label: string; value: string }[];
}) {
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-xs text-muted">Data table</summary>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="border-b border-current/10 text-left">
            <th className="py-1 font-medium text-secondary">{columns[0]}</th>
            <th className="py-1 text-right font-medium text-secondary">{columns[1]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-current/5">
              <td className="py-1">{row.label}</td>
              <td className="py-1 text-right font-mono tabular-nums">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/**
 * Horizontal bars, sorted high → low. Nominal categories, so every bar is the
 * same hue: shading them by size would double-encode length as colour.
 */
export function CategoryBars({ data }: { data: { group: string; total: number }[] }) {
  const max = Math.max(...data.map((d) => d.total), 1);

  return (
    <div>
      <ul className="space-y-2">
        {data.map((row) => (
          <li key={row.group} className="grid grid-cols-[10rem_1fr] items-center gap-3">
            <span className="truncate text-sm text-secondary" title={row.group}>
              {row.group}
            </span>
            <div className="flex items-center gap-2">
              <div
                className="h-4 rounded-r-[4px] bg-viz-series"
                style={{ width: `${(row.total / max) * 100}%` }}
              />
              {/* Value at the tip, in ink — never in the series colour. */}
              <span className="shrink-0 font-mono text-xs tabular-nums text-secondary">
                {formatMoneyWhole(row.total)}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <TableView
        columns={["Category", "Spend"]}
        rows={data.map((d) => ({ label: d.group, value: formatMoneyWhole(d.total) }))}
      />
    </div>
  );
}

/** Round up to a clean axis tick, so the gridline reads as a number. */
function niceMax(value: number) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

/**
 * Columns over time, one series. Labelled selectively: the peak and the most
 * recent month only — a number on every column goes unread.
 */
export function MonthlyColumns({ data }: { data: { key: string; categorised: number }[] }) {
  const peak = Math.max(...data.map((d) => d.categorised), 1);
  const max = niceMax(peak);
  const last = data.at(-1);
  const labelled = new Set([data.find((d) => d.categorised === peak)?.key, last?.key]);

  return (
    <div>
      <div className="relative pl-14">
        {/* Hairline gridline at the top tick, solid and one step off the surface. */}
        <div className="absolute inset-x-14 top-0 border-t border-viz-grid" />
        <span className="absolute left-0 top-0 -translate-y-1/2 font-mono text-[10px] tabular-nums text-muted">
          {formatMoneyWhole(max)}
        </span>
        <span className="absolute left-0 bottom-6 translate-y-1/2 font-mono text-[10px] tabular-nums text-muted">
          $0
        </span>

        <div className="flex h-40 items-end gap-[2px] border-b border-viz-axis">
          {data.map((row) => (
            <div key={row.key} className="flex h-full flex-1 flex-col justify-end">
              {labelled.has(row.key) ? (
                <span className="mb-1 text-center font-mono text-[10px] tabular-nums text-secondary">
                  {formatMoneyWhole(row.categorised)}
                </span>
              ) : null}
              <div
                className="mx-auto w-full max-w-6 rounded-t-[4px] bg-viz-series"
                style={{ height: `${(row.categorised / max) * 100}%` }}
                title={`${formatMonthKey(row.key)}: ${formatMoneyWhole(row.categorised)}`}
              />
            </div>
          ))}
        </div>

        <div className="flex gap-[2px]">
          {data.map((row) => (
            <span key={row.key} className="flex-1 pt-2 text-center text-[10px] text-muted">
              {formatMonthShort(row.key)}
            </span>
          ))}
        </div>
      </div>
      <TableView
        columns={["Month", "Categorised spend"]}
        rows={data.map((d) => ({
          label: formatMonthKey(d.key),
          value: formatMoneyWhole(d.categorised),
        }))}
      />
    </div>
  );
}

/**
 * A single ratio against a limit. The unfilled track is a lighter step of the
 * same hue, so the state reads across the whole bar rather than only the fill.
 */
export function Meter({
  label,
  fraction,
  caption,
}: {
  label: string;
  fraction: number;
  caption: string;
}) {
  return (
    <div className="rounded-lg border border-current/10 p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-secondary">{label}</p>
        <p className="font-mono text-sm tabular-nums">{(fraction * 100).toFixed(0)}%</p>
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-viz-track">
        <div
          className="h-full rounded-full bg-viz-series"
          style={{ width: `${Math.min(100, fraction * 100)}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted">{caption}</p>
    </div>
  );
}
