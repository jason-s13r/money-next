"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatMoneyWhole } from "@/lib/format";
import { formatPeriodKey } from "@/lib/periods";
import type { BalanceSeries } from "@/lib/server/metrics/balance-series";
import { BalanceChartSvg } from "./balance-chart-svg";
import { BalanceChartLegend, type LegendItem } from "./balance-chart-legend";
import {
  AXIS_W,
  C_DOWN,
  C_UP,
  C_WORTH,
  DAY_MS,
  DEFAULT_RANGE,
  FALLBACK_W,
  type Hover,
  compactMoney,
  niceScale,
  PAD_T,
  parseDay,
  PLOT_H,
  RANGES,
  type Row,
  worthAt,
} from "./balance-chart.util";

// Balance over time — a personal version of a stock price chart. "Balance" is the
// accessible balance (net worth minus locked KiwiSaver/investments). The resolution
// is always one day; each day is a bar rising (money in) or dropping (money out)
// from the $0 line by that day's net transaction flow, riding a daily balance line,
// with one forward projection per forecast budget. Those bend: a forecast budget is
// walked forward day by day together with its layers, so an expensive December steps
// down where a burn rate would have run straight. Because a bar *is* the line's step
// for that day, both share one dollar axis. The range buttons set how many days fill
// the width (the zoom); the rest scrolls. Marks follow the house data-viz rules:
// thin lines, a recessive grid, text in ink tokens, colour for identity.
// Layout, palette, scale math and types live in `balance-chart.util.ts`; the SVG
// rendering lives in `balance-chart-svg.tsx` and the legend/range controls in
// `balance-chart-legend.tsx`.

export function BalanceChart({ series }: { series: BalanceSeries }) {
  const { displayCurrency, now, currentWorth, days, nets, worthBoundaries, scenarios } = series;

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

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(FALLBACK_W);
  const [rangeKey, setRangeKey] = useState(DEFAULT_RANGE);

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

  const geom = useMemo(() => {
    const viewportW = Math.max(320, containerW - AXIS_W);
    const range = RANGES.find((r) => r.key === rangeKey)!;
    // The range fixes how many days fill the width; "Max" fits the whole thing.
    const bw = Math.max(0.4, viewportW / (range.days ?? (totalUnits || 1)));
    const plotW = totalUnits * bw;

    // One dollar axis, shared by the line, the bars and the projections. It spans
    // the net-worth boundaries and $0; the net-flow bars root at $0, so their
    // extents (a big in/out day) are folded in too, keeping any bar from
    // clipping. The projected worths join them because a budget that plans to
    // save climbs above every figure history has — an axis fitted to the past
    // would run that line off the top of the plot.
    const projectedWorths = scenarios.flatMap((s) => s.points.map((p) => p.worth));
    const yScale = niceScale(
      Math.min(0, ...worthBoundaries, ...nets, ...projectedWorths),
      Math.max(0, ...worthBoundaries, ...nets, ...projectedWorths),
    );

    const fx = (unit: number) => unit * bw;
    const fy = (v: number) => PAD_T + ((yScale.max - v) / (yScale.max - yScale.min)) * PLOT_H;

    const linePts = worthBoundaries.map((w, i) => `${fx(i)} ${fy(w)}`);
    const worthPath = `M${linePts.join(" L")}`;
    const zeroY = fy(0);
    const worthArea = `${worthPath} L${fx(N)} ${zeroY} L${fx(0)} ${zeroY} Z`;

    const nowX = fx(N);

    // Every projection leaves today's balance at the same point the history line
    // arrives at, then follows its own vertices. A straight-line scenario has one
    // vertex and draws exactly the dash the chart always drew.
    const projections = scenarios
      .filter((s) => s.points.length > 0)
      .map((s) => ({
        id: s.id,
        color: s.color,
        path:
          `M${nowX} ${fy(currentWorth)}` +
          s.points.map((p) => ` L${fx(N + p.day)} ${fy(p.worth)}`).join(""),
      }));

    return { bw, plotW, viewportW, yScale, fx, fy, worthPath, worthArea, nowX, projections };
  }, [containerW, rangeKey, totalUnits, worthBoundaries, nets, N, currentWorth, scenarios]);

  const { bw, plotW, fx, nowX } = geom;

  // Open with today centred in the view (history to its left, the projection to
  // its right), and re-anchor there when the zoom changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, Math.min(plotW - el.clientWidth, nowX - el.clientWidth * 0.5));
  }, [rangeKey, nowX, plotW]);

  // Adaptive x-axis labels: individual days when zoomed in, else calendar
  // boundaries (month → quarter → year) as they get too dense to name each day.
  // Labels continue past the history into the forecast so the projected lines
  // are anchored to readable dates.
  const xLabels = useMemo(() => {
    const out: { x: number; text: string }[] = [];
    const at = (i: number) => fx(i + 0.5);

    const totalDays = N + futureDays;

    if (bw >= 16) {
      const stride = Math.max(1, Math.round(64 / bw));
      for (let i = 0; i < N; i += stride) {
        const { y, m, d } = parseDay(days[i]);
        out.push({ x: at(i), text: dmFmt.format(new Date(Date.UTC(y, m - 1, d))) });
      }
      return out;
    }

    const monthPx = bw * 30.44;
    const mode = monthPx >= 46 ? "month" : monthPx * 3 >= 46 ? "quarter" : "year";

    const pushLabel = (i: number, date: Date) => {
      const y = date.getUTCFullYear();
      const m = date.getUTCMonth() + 1;
      const text =
        mode === "year"
          ? String(y)
          : m === 1
            ? `${monthFmt.format(date)} '${String(y).slice(2)}`
            : monthFmt.format(date);
      out.push({ x: fx(i), text });
    };

    for (let i = 0; i < N; i++) {
      const { y, m, d } = parseDay(days[i]);
      if (d !== 1) continue;
      const isQ = m === 1 || m === 4 || m === 7 || m === 10;
      if (mode === "quarter" && !isQ) continue;
      if (mode === "year" && m !== 1) continue;
      pushLabel(i, new Date(Date.UTC(y, m - 1, d)));
    }

    const lastHistory = parseDay(days[N - 1]);
    const lastHistoryDate = new Date(Date.UTC(lastHistory.y, lastHistory.m - 1, lastHistory.d));
    for (let i = N; i < totalDays; i++) {
      const date = new Date(lastHistoryDate.getTime() + (i - N + 1) * DAY_MS);
      const d = date.getUTCDate();
      if (d !== 1) continue;
      const m = date.getUTCMonth() + 1;
      const isQ = m === 1 || m === 4 || m === 7 || m === 10;
      if (mode === "quarter" && !isQ) continue;
      if (mode === "year" && m !== 1) continue;
      pushLabel(i, date);
    }

    return out;
  }, [bw, N, days, dmFmt, monthFmt, fx, futureDays]);

  const [hover, setHover] = useState<Hover | null>(null);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(plotW, e.clientX - rect.left));
    const unit = x / bw;
    if (unit <= N) {
      const i = Math.min(N - 1, Math.floor(unit));
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
    return {
      label: fullFmt.format(date),
      // One row per scenario still running at this date. A line that has already
      // hit zero drops out of the tooltip rather than reporting $0 for ever.
      rows: scenarios.flatMap((s) => {
        const worth = worthAt(s.points, hover.unit - N, currentWorth);
        return worth === null
          ? []
          : [{ color: s.color, label: s.name, value: money(worth), y: worth }];
      }),
    };
  }, [hover, days, worthBoundaries, nets, now, N, scenarios, currentWorth, fullFmt, money]);

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
        ],
      },
    })),
  ];

  return (
    <figure className="m-0">
      <BalanceChartLegend legend={legend} rangeKey={rangeKey} onRangeChange={setRangeKey} />
      <BalanceChartSvg
        scrollRef={scrollRef}
        geom={geom}
        nets={nets}
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
