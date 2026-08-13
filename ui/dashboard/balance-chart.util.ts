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

// --- the overview strip under the plot, in pixels. ---
export const BRUSH_H = 44;
/** The strip's date band, below the data: one line of small text. */
export const BRUSH_LABEL_H = 16;
/** Closest two dated ticks may be drawn. "Mar" and "2027" are ~26px at this
 *  size; the rest is the gap that keeps them reading as separate marks rather
 *  than as a ruler. */
export const MIN_TICK_PX = 44;
/** Grab width of a window handle. Wider than the handle it sits on, so a thin
 *  mark still clears a finger-sized target. */
export const HANDLE_HIT_W = 24;
/** Narrowest the selection may be drawn on the strip. Two handles and enough
 *  between them to grab: below this the window is a sliver nobody can take hold
 *  of, which is what the strip zooms out of its own domain to avoid. */
export const MIN_SELECTION_PX = 72;
/** How much of the domain the strip shows around the window when it has room —
 *  a window flanked by five windows' worth of context. Bigger frames the window
 *  better but shrinks it; smaller makes the strip a second copy of the plot. */
export const BRUSH_CONTEXT = 6;

/** The zoom buttons: how many days fill the width. `null` = fit all. */
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

/** How many days a range button asks for, `null` for "Max". */
export function rangeDays(key: string): number | null {
  return RANGES.find((r) => r.key === key)?.days ?? null;
}

/**
 * The visible slice of the domain, in day-units from its start: `start` and
 * `end` are day indices, fractional because a dragged edge lands between days.
 * This is what the chart's geometry is built from — the range buttons only set
 * it, and the overview strip's handles drag it.
 */
export type Window = { start: number; end: number };

/** Narrowest window the handles can be dragged to: the tightest zoom the range
 *  buttons offer, so a drag can reach everything a button can. It is not what
 *  keeps the selection grabbable — the strip's own frame does that, see
 *  `brushDomain` — only what keeps the plot worth reading. Below a week the bars
 *  are wider than they are tall and the line is a handful of vertices. */
export const MIN_WINDOW_DAYS = 7;

/**
 * A window fitted into the domain: edges ordered, at least `MIN_WINDOW_DAYS`
 * wide, wholly inside `[0, totalUnits]`.
 *
 * A window pushed past an edge slides back with its width intact rather than
 * being squashed against it — a pan that silently zoomed in when it reached the
 * start of history would be a different gesture than the one being made.
 */
export function clampWindow(win: Window, totalUnits: number): Window {
  const span = Math.max(1, totalUnits);
  const lo = Math.min(win.start, win.end);
  const hi = Math.max(win.start, win.end);
  // A domain shorter than the minimum window is shown whole; there is nothing
  // to zoom into.
  const width = Math.min(span, Math.max(MIN_WINDOW_DAYS, hi - lo));
  const start = Math.max(0, Math.min(span - width, lo));
  return { start, end: start + width };
}

/**
 * The window a range button stands for: `days` wide, centred on today.
 *
 * Centred, because that is where the chart has always opened — history to the
 * left of the divider and the projections to the right of it. `null` fits the
 * whole domain.
 */
export function presetWindow(days: number | null, N: number, totalUnits: number): Window {
  if (days === null) return clampWindow({ start: 0, end: totalUnits }, totalUnits);
  return clampWindow({ start: N - days / 2, end: N + days / 2 }, totalUnits);
}

/**
 * Which range button, if any, describes `win` — `null` once it has been dragged
 * off a preset, so no button claims to be showing what the reader is looking at.
 */
export function matchPreset(win: Window, N: number, totalUnits: number): string | null {
  for (const r of RANGES) {
    const p = presetWindow(r.days, N, totalUnits);
    if (Math.abs(p.start - win.start) < 0.5 && Math.abs(p.end - win.end) < 0.5) return r.key;
  }
  return null;
}

/**
 * How much of the domain the overview strip draws, given the window it has to
 * draw over it.
 *
 * The strip cannot show five years and offer a grabbable month at the same
 * time: a 30-day window in a 1,900-day strip is eleven pixels on a phone. So the
 * strip zooms too. It shows `BRUSH_CONTEXT` windows' worth of domain, tightened
 * further where that would still leave the selection under `MIN_SELECTION_PX`,
 * and never more than the domain nor less than the window itself.
 */
export function brushSpan(winSpan: number, width: number, totalUnits: number): number {
  const byPixels = winSpan * (Math.max(1, width) / MIN_SELECTION_PX);
  const target = Math.min(winSpan * BRUSH_CONTEXT, byPixels);
  return Math.min(Math.max(1, totalUnits), Math.max(winSpan, target));
}

/**
 * The slice of the domain the strip should draw: `prev` kept where it still
 * frames `win` well, else a fresh frame centred on it.
 *
 * `settled` is the difference between a drag in progress and one that has ended.
 * Mid-drag the frame never rescales — that would slide the data out from under
 * the pointer and set the gesture chasing itself — and does no more than follow
 * the window: sliding by the least that keeps it inside, and widening to just
 * hold a window dragged wider than the frame. Nothing needs to be grabbable
 * while the pointer already has hold of it.
 *
 * On settle the frame is re-fitted, but only once the window's width has
 * wandered far enough from what the frame was built for that keeping it would
 * mean a sliver or a strip with no room around the window. That is what turns a
 * zoom into a strip that zoomed with it, and what leaves a pan alone.
 */
export function brushDomain(
  win: Window,
  prev: Window | null,
  totalUnits: number,
  width: number,
  settled: boolean,
): Window {
  const winSpan = Math.max(1e-6, win.end - win.start);
  const target = brushSpan(winSpan, width, totalUnits);

  if (prev) {
    const span = prev.end - prev.start;
    if (!settled) {
      return span >= winSpan
        ? slideToContain(prev, win, totalUnits)
        : frameAt(win.start, winSpan, totalUnits);
    }
    // A factor of two either way before a settled frame is rebuilt, so nudging a
    // handle a few days does not re-lay the strip under the reader — bounded by
    // the width that still draws a selection worth `MIN_SELECTION_PX`, which is
    // the promise the frame exists to keep.
    const grabbable = winSpan * (Math.max(1, width) / MIN_SELECTION_PX) + 1e-6;
    if (span >= Math.max(winSpan, target / 2) && span <= Math.min(target * 2, grabbable)) {
      return slideToContain(prev, win, totalUnits);
    }
  }

  const mid = (win.start + win.end) / 2;
  return frameAt(mid - target / 2, target, totalUnits);
}

/** How the strip's date band is stepped, coarsening as the frame widens. */
export type TickStep = "day" | "week" | "month" | "quarter" | "year";

const STEP_DAYS: [TickStep, number][] = [
  ["day", 1],
  ["week", 7],
  ["month", 30.44],
  ["quarter", 91.3],
  ["year", 365.25],
];

/** The finest step the strip can date at `dpx` pixels per day. */
export function tickStep(dpx: number): TickStep {
  for (const [step, days] of STEP_DAYS) if (days * dpx >= MIN_TICK_PX) return step;
  return "year";
}

/** A dated mark under the strip. `rank` is how much calendar it starts — 2 a
 *  year, 1 a month, 0 a day or a week — and is what a crowded band drops by. */
export type BrushTick = { unit: number; text: string; rank: 0 | 1 | 2 };

/**
 * The dated ticks under the strip, at the finest calendar step its frame has
 * room for: days, Mondays, months, quarters or years.
 *
 * The band keeps one rhythm, the step's own. Where the step is a month or
 * wider, each mark is named for the month or the year it opens; where it is
 * finer, every label already carries its month — "10 Aug" — and an "Aug" cut
 * into the middle of them would be the one mark not answering the question its
 * neighbours answer. A year is picked up there by suffixing the first label
 * inside it, which is what the plot's own axis does with a January.
 *
 * Where two marks crowd, the smaller unit of time gives way: a month pressed
 * against the start of a year is noise, since the year is the better answer to
 * where this is. Whole levels drop out that way as the frame widens — months
 * thin to quarters, quarters to the bare years.
 *
 * Dates come from `dateAt` rather than being computed here, so the band names
 * the same days the plot's axis does. `width` is the strip's, in pixels.
 */
export function brushTicks(
  domain: Window,
  width: number,
  dateAt: (unit: number) => Date,
  label: { month: (d: Date) => string; day: (d: Date) => string },
): BrushTick[] {
  const span = Math.max(1e-6, domain.end - domain.start);
  const dpx = Math.max(1, width) / span;
  const step = tickStep(dpx);

  // Days are whole and evenly spaced, so one date fixes the rest of the frame.
  const u0 = Math.max(0, Math.floor(domain.start));
  const from = dateAt(u0);
  const to = dateAt(Math.ceil(domain.end));
  const unitOf = (d: Date) => u0 + (d.getTime() - from.getTime()) / DAY_MS;

  // Whether a mark is named for the calendar it opens or for its own date: the
  // step decides, so that one band never mixes the two.
  const named = step === "month" || step === "quarter" || step === "year";

  const cand: BrushTick[] = [];
  const add = (d: Date) => {
    const unit = unitOf(d);
    if (unit < domain.start || unit > domain.end) return;
    const first = d.getUTCDate() === 1;
    const jan = first && d.getUTCMonth() === 0;
    cand.push({
      unit,
      text: named ? (jan ? String(d.getUTCFullYear()) : label.month(d)) : label.day(d),
      // Ranked even where the text does not say so: the first of a month still
      // earns the longer tick, and still wins a crowded spot.
      rank: jan ? 2 : first ? 1 : 0,
    });
  };

  if (step === "year") {
    for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
      add(new Date(Date.UTC(y, 0, 1)));
    }
  } else if (named) {
    // Quarters count from January, so the same three months are marked whatever
    // month the frame happens to open on.
    const by = step === "quarter" ? 3 : 1;
    const m0 = Math.floor(from.getUTCMonth() / by) * by;
    for (let d = new Date(Date.UTC(from.getUTCFullYear(), m0, 1)); d <= to; ) {
      add(d);
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + by, 1));
    }
  } else if (step === "week") {
    // Weeks start on Monday, the day the rest of the app counts them from.
    const first = from.getTime() + ((8 - from.getUTCDay()) % 7) * DAY_MS;
    for (let t = first; t <= to.getTime(); t += 7 * DAY_MS) add(new Date(t));
  } else {
    for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) add(new Date(t));
  }

  // Biggest units placed first, each smaller one only where there is still room
  // for it. This is also what de-duplicates: a Monday that is the first of the
  // month lands on a mark already taken, and the month keeps it.
  const kept: BrushTick[] = [];
  for (const rank of [2, 1, 0] as const) {
    for (const t of cand.filter((c) => c.rank === rank).sort((a, b) => a.unit - b.unit)) {
      // A same-rank neighbour is held to less, because the step it came from was
      // already chosen to fit: only an actual overlap of text drops one.
      const clear = kept.every(
        (k) => Math.abs(k.unit - t.unit) * dpx >= (k.rank > t.rank ? MIN_TICK_PX : MIN_TICK_PX * 0.7),
      );
      if (clear) kept.push(t);
    }
  }

  kept.sort((a, b) => a.unit - b.unit);

  // A band of dates that never names its year, on a chart holding five of them.
  // The first label inside each new one carries it.
  if (!named) {
    let year = 0;
    for (const t of kept) {
      const y = dateAt(t.unit).getUTCFullYear();
      if (year && y !== year) t.text = `${t.text} '${String(y).slice(2)}`;
      year = y;
    }
  }

  return kept;
}

/** `prev` moved by the least that puts `win` back inside it, width intact. */
function slideToContain(prev: Window, win: Window, totalUnits: number): Window {
  const span = prev.end - prev.start;
  let start = prev.start;
  if (win.start < start) start = win.start;
  if (win.end > start + span) start = win.end - span;
  return frameAt(start, span, totalUnits);
}

/** A `span`-wide frame at `start`, pushed inside `[0, totalUnits]`. */
function frameAt(start: number, span: number, totalUnits: number): Window {
  const s = Math.min(Math.max(0, totalUnits - span), Math.max(0, start));
  return { start: s, end: s + span };
}

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

/** A daily flow bar the plot has placed: `x` in plot pixels, `value` its net
 *  flow, `key` its index in the series it came from. Only the bars the window
 *  shows are built. */
export type Bar = { key: number; x: number; value: number };

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
