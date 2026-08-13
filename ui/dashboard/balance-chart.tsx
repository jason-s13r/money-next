"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatMoneyWhole } from "@/lib/format";
import { formatPeriodKey } from "@/lib/periods";
import { runwayPhases } from "@/lib/budget/projection";
import type { BalanceSeries } from "@/lib/server/metrics/balance-series";
import { BalanceChartSvg } from "./balance-chart-svg";
import { BalanceChartBrush } from "./balance-chart-brush";
import { BalanceChartLegend, type LegendItem } from "./balance-chart-legend";
import {
  AXIS_W,
  type Bar,
  brushDomain,
  brushTicks,
  C_DOWN,
  C_PLANNED,
  C_UP,
  C_WORTH,
  clampWindow,
  DAY_MS,
  DEFAULT_RANGE,
  FALLBACK_W,
  type Hover,
  compactMoney,
  matchPreset,
  niceScale,
  PAD_T,
  parseDay,
  PLOT_H,
  presetWindow,
  rangeDays,
  type Row,
  type Window,
  worthAt,
} from "./balance-chart.util";

// Balance over time — a personal version of a stock price chart. "Balance" is the
// accessible balance (net worth minus locked KiwiSaver/investments). The resolution
// is always one day; each day is a bar rising (money in) or dropping (money out)
// from the $0 line by that day's net transaction flow, riding a daily balance line,
// with one forward projection per forecast budget. Those bend: a forecast budget is
// walked forward day by day together with its layers, so an expensive December steps
// down where a burn rate would have run straight. Those lines may pass under the
// $0 axis: where the workspace has a card or an overdraft, the plan keeps being
// spendable after the balance is gone, and the line runs on to the marked credit
// floor and stops there. Because a bar *is* the line's step
// for that day, both share one dollar axis, fitted to whatever the window shows.
// What is shown is a window over the domain, and the overview strip underneath
// both draws it and drags it; the range buttons are shortcuts that set it. Marks
// follow the house data-viz rules: thin lines, a recessive grid, text in ink
// tokens, colour for identity.
// Layout, palette, scale math, window math and types live in
// `balance-chart.util.ts`; the SVG rendering lives in `balance-chart-svg.tsx`,
// the overview strip in `balance-chart-brush.tsx` and the legend/range controls
// in `balance-chart-legend.tsx`.

export function BalanceChart({ series }: { series: BalanceSeries }) {
  const {
    displayCurrency,
    now,
    currentWorth,
    creditFloor,
    days,
    nets,
    projectedNets,
    worthBoundaries,
    scenarios,
  } = series;

  const N = days.length;

  const money = useCallback(
    (n: number) => formatMoneyWhole(n, displayCurrency),
    [displayCurrency],
  );
  const compact = useCallback(
    (n: number) => compactMoney(n, displayCurrency),
    [displayCurrency],
  );
  const monthFmt = useMemo(() => new Intl.DateTimeFormat("en-NZ", { timeZone: "UTC", month: "short" }), []);
  const dmFmt = useMemo(
    () => new Intl.DateTimeFormat("en-NZ", { timeZone: "UTC", day: "numeric", month: "short" }),
    [],
  );
  const fullFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-NZ", {
        timeZone: "UTC",
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    [],
  );

  const containerRef = useRef<HTMLElement>(null);
  const [containerW, setContainerW] = useState(FALLBACK_W);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setContainerW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // How far past today the drawing reaches: the longest line any scenario draws.
  // A scenario that runs out ends there; one that does not ends at the horizon it
  // was projected to.
  const futureDays = useMemo(
    () => Math.max(0, ...scenarios.map((s) => s.points[s.points.length - 1]?.day ?? 0)),
    [scenarios],
  );
  const totalUnits = N + futureDays;

  // The planned bars only fill the days the drawing actually reaches: a chart
  // whose every scenario runs out in month seven stops there, and bars for the
  // remaining seventeen months would be flow attached to no line. Whole days
  // only, so the last bar cannot poke past a fractional depletion edge.
  const plannedNets = useMemo(
    () => projectedNets.slice(0, Math.floor(futureDays)),
    [projectedNets, futureDays],
  );

  // The visible slice of the domain: the one thing the plot's geometry is built
  // from. It opens on the default range; from there the strip's handles drag it
  // and the range buttons jump it. Re-fitted whenever the domain changes under
  // it — a sync that extends history, or a forecast budget that lengthens the
  // projections, must not leave the window pointing off the end of the data.
  const [storedWin, setStoredWin] = useState<Window>(() =>
    presetWindow(rangeDays(DEFAULT_RANGE), N, totalUnits),
  );
  const win = useMemo(() => clampWindow(storedWin, totalUnits), [storedWin, totalUnits]);

  // The plot fills whatever the card leaves it. A floor rather than the card's
  // real width so a narrow phone cannot drive the geometry to nothing.
  const viewportW = Math.max(120, containerW - AXIS_W);

  // What the overview strip draws over: not always the whole domain, because a
  // month inside five years is a selection too thin to take hold of. Only a
  // finished gesture may re-frame it — mid-drag it does no more than follow the
  // window — so it is the settled frame that is kept, and the live one derived.
  const [settledDomain, setSettledDomain] = useState<Window>(() =>
    brushDomain(presetWindow(rangeDays(DEFAULT_RANGE), N, totalUnits), null, totalUnits, viewportW, true),
  );
  const brushWin = useMemo(
    () => brushDomain(win, settledDomain, totalUnits, viewportW, false),
    [win, settledDomain, totalUnits, viewportW],
  );

  const setWin = useCallback(
    (next: Window, settled: boolean) => {
      const fitted = clampWindow(next, totalUnits);
      setStoredWin(fitted);
      if (settled) setSettledDomain((prev) => brushDomain(fitted, prev, totalUnits, viewportW, true));
    },
    [totalUnits, viewportW],
  );

  const geom = useMemo(() => {
    // Bar width is shared by the recorded and the planned days: a forward bar is
    // the same daily unit as a historic one, and drawing it any other size would
    // make the plan look like a different resolution.
    const bw = viewportW / Math.max(1, win.end - win.start);
    const fx = (unit: number) => (unit - win.start) * bw;

    // The recorded days the window touches, and the planned ones — a day either
    // side, so the line enters and leaves the frame instead of beginning at its
    // edge. Everything below is built over these bounds rather than the whole
    // domain: a drag re-runs this per frame, and the domain is a few thousand
    // days.
    const h1 = Math.min(N, Math.ceil(win.end) + 1);
    const h0 = Math.max(0, Math.min(h1, Math.floor(win.start) - 1));
    const p1 = Math.min(plannedNets.length, Math.max(0, Math.ceil(win.end - N) + 1));
    const p0 = Math.max(0, Math.min(p1, Math.floor(win.start - N) - 1));

    const visibleWorths = worthBoundaries.slice(h0, h1 + 1);
    const visibleNets = nets.slice(h0, h1);
    const visiblePlanned = plannedNets.slice(p0, p1);

    // Where each projection stands as it crosses the window: the vertices inside
    // it, plus its value at each edge — a window falling between two vertices
    // contains none at all, and a line the scale never heard of would be drawn
    // off the top of the plot.
    const projectedWorths = scenarios.flatMap((s) => [
      ...s.points
        .filter((p) => N + p.day >= win.start - 1 && N + p.day <= win.end + 1)
        .map((p) => p.worth),
      ...[win.start - N, win.end - N].flatMap((day) => {
        const worth = worthAt(s.points, day, currentWorth);
        return worth === null ? [] : [worth];
      }),
    ]);

    // One dollar axis, shared by the line, the bars and the projections, and
    // fitted to what the window shows: a fortnight of 2021 read against 2026's
    // peak is a flat line, and a zoom that could not change the scale would not
    // be a zoom. $0 stays in it whatever the window — the net-flow bars are
    // rooted there, and a scale that left it out would draw every one of them
    // full height.
    const yScale = niceScale(
      Math.min(0, ...visibleWorths, ...visibleNets, ...visiblePlanned, ...projectedWorths),
      Math.max(0, ...visibleWorths, ...visibleNets, ...visiblePlanned, ...projectedWorths),
    );

    const fy = (v: number) => PAD_T + ((yScale.max - v) / (yScale.max - yScale.min)) * PLOT_H;

    const linePts: string[] = [];
    for (let k = h0; k <= h1; k++) linePts.push(`${fx(k)} ${fy(worthBoundaries[k])}`);
    const zeroY = fy(0);
    // Null where the window has moved wholly past the end of history: there is
    // no line left in frame, only the projections.
    const worthPath = linePts.length > 1 ? `M${linePts.join(" L")}` : null;
    const worthArea = worthPath ? `${worthPath} L${fx(h1)} ${zeroY} L${fx(h0)} ${zeroY} Z` : null;

    const historyBars: Bar[] = [];
    for (let i = h0; i < h1; i++) historyBars.push({ key: i, x: fx(i), value: nets[i] });
    const plannedBars: Bar[] = [];
    for (let j = p0; j < p1; j++) plannedBars.push({ key: j, x: fx(N + j), value: plannedNets[j] });

    const nowX = fx(N);

    // Every projection leaves today's balance at the same point the history line
    // arrives at, then follows its own vertices. A straight-line scenario has one
    // vertex and draws exactly the dash the chart always drew. Whole lines, left
    // for the SVG's own edges to crop — a projection is a handful of vertices,
    // so there is nothing to be saved by clipping it here.
    const projections = scenarios
      .filter((s) => s.points.length > 0)
      .map((s) => ({
        id: s.id,
        color: s.color,
        path:
          `M${nowX} ${fy(currentWorth)}` +
          s.points.map((p) => ` L${fx(N + p.day)} ${fy(p.worth)}`).join(""),
      }));

    // The credit floor, marked only once a line has gone under the axis. A
    // facility nobody's plan draws on is not news, and forcing the axis down to
    // an untouched limit would flatten the part of the chart being read.
    // `walkProjection` lands a bottoming-out line exactly on the floor, so
    // whenever it matters the scale already reaches it.
    const floor =
      creditFloor < 0 && creditFloor >= yScale.min ? { y: fy(creditFloor), value: creditFloor } : null;

    return {
      bw,
      viewportW,
      yScale,
      fx,
      fy,
      worthPath,
      worthArea,
      nowX,
      historyBars,
      plannedBars,
      projections,
      floor,
    };
  }, [
    viewportW,
    win,
    worthBoundaries,
    nets,
    plannedNets,
    N,
    currentWorth,
    creditFloor,
    scenarios,
  ]);

  const { bw, fx } = geom;

  // The date a day-unit stands for, on either side of today: recorded days are
  // named by the series, planned ones counted forward off the last of them.
  const dateAt = useCallback(
    (i: number) => {
      const { y, m, d } = parseDay(days[Math.min(i, N - 1)]);
      const base = Date.UTC(y, m - 1, d);
      return new Date(i < N ? base : base + (i - N + 1) * DAY_MS);
    },
    [days, N],
  );

  // The strip's date band follows the strip's own frame, not the window: the
  // frame is what is being scanned for somewhere to drag to, and dates borrowed
  // from the plot above would be describing a different span of time.
  const tickLabel = useMemo(
    () => ({ month: (d: Date) => monthFmt.format(d), day: (d: Date) => dmFmt.format(d) }),
    [monthFmt, dmFmt],
  );
  const brushDates = useMemo(
    () => brushTicks(brushWin, viewportW, dateAt, tickLabel),
    [brushWin, viewportW, dateAt, tickLabel],
  );

  // Adaptive x-axis labels: individual days when zoomed in, else calendar
  // boundaries (month → quarter → year) as they get too dense to name each day.
  // Only the window's own days are walked, and labels run right through today
  // into the forecast so the projected lines are anchored to readable dates.
  const xLabels = useMemo(() => {
    const out: { x: number; text: string }[] = [];
    const totalDays = N + futureDays;
    const from = Math.max(0, Math.floor(win.start));
    const to = Math.min(totalDays - 1, Math.ceil(win.end));

    if (bw >= 16) {
      const stride = Math.max(1, Math.round(64 / bw));
      // Anchored to a fixed grid rather than to the window's own edge, so the
      // labels travel with the plot as it is dragged instead of reshuffling.
      for (let i = Math.ceil(from / stride) * stride; i <= to; i += stride) {
        out.push({ x: fx(i + 0.5), text: dmFmt.format(dateAt(i)) });
      }
      return out;
    }

    const monthPx = bw * 30.44;
    const mode = monthPx >= 46 ? "month" : monthPx * 3 >= 46 ? "quarter" : "year";

    for (let i = from; i <= to; i++) {
      const date = dateAt(i);
      if (date.getUTCDate() !== 1) continue;
      const m = date.getUTCMonth() + 1;
      const isQ = m === 1 || m === 4 || m === 7 || m === 10;
      if (mode === "quarter" && !isQ) continue;
      if (mode === "year" && m !== 1) continue;
      const y = date.getUTCFullYear();
      out.push({
        x: fx(i),
        text:
          mode === "year"
            ? String(y)
            : m === 1
              ? `${monthFmt.format(date)} '${String(y).slice(2)}`
              : monthFmt.format(date),
      });
    }

    return out;
  }, [bw, N, dateAt, dmFmt, monthFmt, fx, futureDays, win]);

  const [hover, setHover] = useState<Hover | null>(null);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(viewportW, e.clientX - rect.left));
    const unit = win.start + x / bw;
    if (unit <= N) {
      const i = Math.max(0, Math.min(N - 1, Math.floor(unit)));
      setHover({ kind: "history", x: fx(i + 1), i });
    } else {
      setHover({ kind: "future", x, unit });
    }
  };

  const info = useMemo((): { label: string; rows: Row[] } | null => {
    if (!hover) return null;
    if (hover.kind === "history") {
      const i = hover.i;
      return {
        label: formatPeriodKey(days[i], "day"),
        rows: [
          { color: "var(--text-secondary)", label: "Balance", value: money(worthBoundaries[i + 1]) },
          {
            color: nets[i] >= 0 ? C_UP : C_DOWN,
            label: nets[i] >= 0 ? "Net in" : "Net out",
            value: money(nets[i]),
          },
        ],
      };
    }
    const date = new Date(now + (hover.unit - N) * DAY_MS);
    const planned = plannedNets[Math.floor(hover.unit) - N];
    return {
      label: fullFmt.format(date),
      // One row per scenario still running at this date. A line that has already
      // hit zero drops out of the tooltip rather than reporting $0 for ever.
      rows: [
        ...scenarios.flatMap((s) => {
          const worth = worthAt(s.points, hover.unit - N, currentWorth);
          return worth === null
            ? []
            : [{ color: s.color, label: s.name, value: money(worth), y: worth }];
        }),
        // What the grey bar under the cursor is worth. Named for the averaging
        // when there is more than one forecast, because "planned in" over a row
        // of per-budget balances would otherwise read as belonging to the last of
        // them. Silent on a day nothing is planned: an explicit $0 in a list of
        // real figures reads as a fact rather than as an empty day.
        ...(planned
          ? [
              {
                color: C_PLANNED,
                label:
                  scenarios.length > 1
                    ? planned >= 0
                      ? "Planned in · avg"
                      : "Planned out · avg"
                    : planned >= 0
                      ? "Planned in"
                      : "Planned out",
                value: money(planned),
              },
            ]
          : []),
      ],
    };
  }, [
    hover,
    days,
    worthBoundaries,
    nets,
    plannedNets,
    now,
    N,
    scenarios,
    currentWorth,
    fullFmt,
    money,
  ]);

  const legend: LegendItem[] = [
    { color: C_WORTH, label: "Available balance" },
    ...scenarios.map((s) => ({
      color: s.color,
      dashed: true,
      // Whole dollars, not the axis's shorthand: a legend figure is read for
      // its value, and "$1.8K/mo" is worse at that than "$1,831/mo".
      //
      // Same rule as the runway tile on the sign: a negative burn is a surplus,
      // and reading it back as a minus in front of a dollar amount helps nobody.
      label:
        s.monthlyBurn === null
          ? s.name
          : s.monthlyBurn >= 0
            ? `${s.name} · ${money(s.monthlyBurn)}/mo`
            : `${s.name} · ${money(-s.monthlyBurn)}/mo spare`,
      popover: {
        note: scenarioNote(s.blendedDays),
        rows: [
          { label: "Planned expenses", value: `${money(s.monthlyOut)}/mo` },
          ...(s.monthlyIn > 0
            ? [{ label: "Less planned income", value: `−${money(s.monthlyIn)}/mo` }]
            : []),
          {
            label: s.monthlyBurn !== null && s.monthlyBurn < 0 ? "Net spare" : "Net burn",
            value:
              s.monthlyBurn === null
                ? "—"
                : `${money(Math.abs(s.monthlyBurn))}/mo`,
            emphasis: true,
          },
          // How long that rate lasts, in the two phases the line draws: down to
          // the axis on the balance, then down to the credit floor on borrowing.
          // The same builder the runway tile uses, so the legend and the tile
          // cannot come to different conclusions about the same scenario. The
          // date credit runs out is left to the tile: here the line already ends
          // on the floor, which is the same fact drawn instead of written.
          ...runwayPhases(s).map((phase, i) => ({ ...phase, divider: i === 0 })),
        ],
      },
    })),
  ];

  // Which range button, if any, is showing — none once the window has been
  // dragged off every preset.
  const rangeKey = useMemo(() => matchPreset(win, N, totalUnits), [win, N, totalUnits]);
  const onRangeChange = useCallback(
    (key: string) => setWin(presetWindow(rangeDays(key), N, totalUnits), true),
    [setWin, N, totalUnits],
  );

  return (
    <figure ref={containerRef} className="m-0">
      <BalanceChartLegend legend={legend} rangeKey={rangeKey} onRangeChange={onRangeChange} />
      <BalanceChartSvg
        geom={geom}
        worthBoundaries={worthBoundaries}
        currentWorth={currentWorth}
        displayCurrency={displayCurrency}
        compact={compact}
        xLabels={xLabels}
        hover={hover}
        info={info}
        onMove={onMove}
        onLeave={() => setHover(null)}
      />
      {/* The overview strip, indented to sit under the plot rather than under
          the axis gutter, so its selection lines up with what it selects. */}
      <div className="mt-2 flex">
        <div className="shrink-0" style={{ width: AXIS_W }} />
        <BalanceChartBrush
          width={viewportW}
          totalUnits={totalUnits}
          domain={brushWin}
          N={N}
          worthBoundaries={worthBoundaries}
          scenarios={scenarios}
          ticks={brushDates}
          win={win}
          onChange={setWin}
          unitLabel={(unit) => fullFmt.format(dateAt(Math.max(0, Math.min(totalUnits - 1, Math.round(unit)))))}
        />
      </div>
    </figure>
  );
}

/**
 * What a forecast budget's legend popover says about where its line came from.
 *
 * Only the uncovered-day count, and it is said out loud on purpose: a forecast
 * mostly filled in from history is barely a plan, and the reader deserves that
 * before trusting its date. Naming the budget is left to the legend label the
 * popover hangs off — repeating it here, layers and all, said nothing the reader
 * had not just clicked on.
 */
function scenarioNote(blendedDays: number): string | null {
  if (blendedDays === 0) return null;
  return `${blendedDays.toLocaleString("en-NZ")} days ahead aren't covered by this budget and run at your historic rate.`;
}
