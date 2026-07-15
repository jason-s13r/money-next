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
// entity, never cycled: net worth cool, the two depletion projections warm, an
// up day green, a down day orange.
export const C_WORTH = "var(--viz-1)";
export const C_FORECAST = "var(--viz-1)";
export const C_EMERGENCY = "var(--viz-3)";
export const C_PESSIMISTIC = "var(--viz-6)";
export const C_UP = "var(--viz-2)";
export const C_DOWN = "var(--viz-8)";

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
