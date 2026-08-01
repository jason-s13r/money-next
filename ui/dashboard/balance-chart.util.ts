// Layout, palette, scale math and types for `balance-chart.tsx` — the parts that
// carry no React state, split out so the component file is just the render.

// --- fixed vertical layout, in pixels (set height; only width is dynamic). ---
export const PAD_T = 8;
export const PLOT_H = 262;
export const LABEL_H = 22;
export const PLOT_Y1 = PAD_T + PLOT_H;
export const H = PLOT_Y1 + LABEL_H;
export const AXIS_W = 56;

export const FALLBACK_W = 960; // container width before it is measured (also the SSR width)
export const DAY_MS = 86_400_000;
export const DAYS_PER_MONTH = 365.25 / 12;

/** The zoom buttons: how many days of history fill the width. `null` = fit all. */
export const RANGES: { key: string; days: number | null }[] = [
  { key: "1W", days: 7 },
  { key: "1M", days: 30 },
  { key: "3M", days: 91 },
  { key: "6M", days: 182 },
  { key: "9M", days: 273 },
  { key: "1Y", days: 365 },
  { key: "2Y", days: 730 },
  { key: "Max", days: null },
];
export const DEFAULT_RANGE = "9M";

// Entity → colour. A subset of the app's validated categorical slots, one per
// entity, never cycled: net worth cool, an up day green, a down day orange.
// Projections are not here — each forecast budget carries its own derived
// colour, so it keeps it when a neighbour is added or deleted.
export const C_WORTH = "var(--viz-1)";
export const C_UP = "var(--viz-2)";
export const C_DOWN = "var(--viz-8)";
// Planned days ahead: the de-emphasis grey, not a ninth categorical slot. A green
// forward bar would claim a payday happened; grey says the same shape is a plan,
// and leaves in/out to be read from which side of the $0 line the bar hangs on.
export const C_PLANNED = "var(--viz-unknown)";

/**
 * Money in axis shorthand: `$40K`, `-$1.2M`, `$850`.
 *
 * Written out by hand rather than handed to `Intl`'s own `notation: "compact"`,
 * which disagrees with itself across ICU versions about whether $40,000 is "$40K"
 * or "$40.0K" — the server and the browser then render different text and React
 * throws a hydration mismatch on a chart axis, which is about the last place
 * anyone would look for one. Scaling here and formatting a plain decimal leaves
 * `Intl` doing only the part it does identically everywhere.
 */
export function compactMoney(value: number, currency: string): string {
  const abs = Math.abs(value);
  const [scale, suffix] =
    abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];

  const scaled = value / scale;
  // One decimal only where it says something: $1.2M earns it, $40K does not.
  const digits = suffix && Math.abs(scaled) < 10 && Math.round(scaled * 10) % 10 !== 0 ? 1 : 0;

  return (
    new Intl.NumberFormat("en-NZ", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(scaled) + suffix
  );
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range || 1));
  const f = range / Math.pow(10, exp);
  const nf = round
    ? f < 1.5
      ? 1
      : f < 3
        ? 2
        : f < 7
          ? 5
          : 10
    : f <= 1
      ? 1
      : f <= 2
        ? 2
        : f <= 5
          ? 5
          : 10;
  return nf * Math.pow(10, exp);
}

/** A rounded [min, max] and evenly spaced ticks covering a data range. */
export function niceScale(min: number, max: number, count = 6) {
  if (min === max) max = min + 1;
  const step = niceNum((max - min) / Math.max(1, count - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(Math.round(v));
  return { min: niceMin, max: niceMax, ticks };
}

/** `YYYY-MM-DD` → parts, cheaply. */
export function parseDay(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

export type Hover =
  | { kind: "history"; x: number; i: number }
  | { kind: "future"; x: number; unit: number };

export type Row = { color: string; label: string; value: string; y?: number };

/** A vertex of a projected line: `day` days past today, `worth` at the end of it.
 *  Mirrors `ProjectionPoint` on the server, kept structural so the client module
 *  does not import a `server-only` one. */
export type Point = { day: number; worth: number };

/**
 * The projected balance at `day`, interpolated along the polyline.
 *
 * The line is a vertex per *change*, so the value between two vertices is the
 * straight segment joining them — the same interpolation the renderer draws, so
 * the crosshair reads the pixel it sits on. Null past the line's own end: a
 * projection that has run out has no worth to report, and continuing it flat
 * would claim the balance stops falling exactly when the plan stops describing
 * it.
 */
export function worthAt(points: Point[], day: number, start: number): number | null {
  if (points.length === 0 || day < 0 || day > points[points.length - 1].day) return null;

  let prevDay = 0;
  let prevWorth = start;
  for (const point of points) {
    if (day <= point.day) {
      const span = point.day - prevDay;
      if (span <= 0) return point.worth;
      return prevWorth + ((point.worth - prevWorth) * (day - prevDay)) / span;
    }
    prevDay = point.day;
    prevWorth = point.worth;
  }
  return prevWorth;
}
