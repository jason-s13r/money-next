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
  C_EMERGENCY,
  C_FORECAST,
  C_PESSIMISTIC,
  C_UP,
  C_WORTH,
  DAY_MS,
  DAYS_PER_MONTH,
  DEFAULT_RANGE,
  FALLBACK_W,
  type Hover,
  niceScale,
  PAD_T,
  parseDay,
  PLOT_H,
  RANGES,
  type Row,
} from "./balance-chart.util";

// Balance over time — a personal version of a stock price chart. "Balance" is the
// accessible balance (net worth minus locked KiwiSaver/investments). The resolution
// is always one day; each day is a bar rising (money in) or dropping (money out)
// from the $0 line by that day's net transaction flow, riding a daily balance line,
// with two forward burn-rate projections. Because a bar *is* the line's step for
// that day, both share one dollar axis. The range buttons set how many days fill
// the width (the zoom); the rest scrolls. Marks follow the house data-viz rules:
// thin lines, a recessive grid, text in ink tokens, colour for identity.
// Layout, palette, scale math and types live in `balance-chart.util.ts`; the SVG
// rendering lives in `balance-chart-svg.tsx` and the legend/range controls in
// `balance-chart-legend.tsx`.

export function BalanceChart({ series }: { series: BalanceSeries }) {
  const {
    displayCurrency,
    now,
    currentWorth,
    days,
    nets,
    worthBoundaries,
    forecastMonthly,
    emergencyMonthly,
    pessimisticMonthly,
    forecastMonths,
    emergencyMonths,
    pessimisticMonths,
  } = series;

  const N = days.length;

  const money = useCallback(
    (n: number) => formatMoneyWhole(n, displayCurrency),
    [displayCurrency],
  );
  const compact = useMemo(
    () =>
      new Intl.NumberFormat("en-NZ", {
        style: "currency",
        currency: displayCurrency,
        notation: "compact",
        maximumFractionDigits: 1,
      }),
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

  const futureForecast = forecastMonths != null ? forecastMonths * DAYS_PER_MONTH : 0;
  const futureEmergency = emergencyMonths != null ? emergencyMonths * DAYS_PER_MONTH : 0;
  const futurePessimistic = pessimisticMonths != null ? pessimisticMonths * DAYS_PER_MONTH : 0;
  const totalUnits = N + Math.max(futureForecast, futureEmergency, futurePessimistic);

  const geom = useMemo(() => {
    const viewportW = Math.max(320, containerW - AXIS_W);
    const range = RANGES.find((r) => r.key === rangeKey)!;
    // The range fixes how many days fill the width; "Max" fits the whole thing.
    const bw = Math.max(0.4, viewportW / (range.days ?? (totalUnits || 1)));
    const plotW = totalUnits * bw;

    // One dollar axis, shared by the line and the bars. It spans the net-worth
    // boundaries and $0; the net-flow bars root at $0, so their extents (a big
    // in/out day) are folded in too, keeping any bar from clipping.
    const yScale = niceScale(
      Math.min(0, ...worthBoundaries, ...nets),
      Math.max(0, ...worthBoundaries, ...nets),
    );

    const fx = (unit: number) => unit * bw;
    const fy = (v: number) => PAD_T + ((yScale.max - v) / (yScale.max - yScale.min)) * PLOT_H;

    const linePts = worthBoundaries.map((w, i) => `${fx(i)} ${fy(w)}`);
    const worthPath = `M${linePts.join(" L")}`;
    const zeroY = fy(0);
    const worthArea = `${worthPath} L${fx(N)} ${zeroY} L${fx(0)} ${zeroY} Z`;

    const nowX = fx(N);
    const proj = (units: number) => `M${nowX} ${fy(currentWorth)} L${fx(N + units)} ${zeroY}`;

    return {
      bw,
      plotW,
      viewportW,
      yScale,
      fx,
      fy,
      worthPath,
      worthArea,
      nowX,
      forecastPath: futureForecast > 0 ? proj(futureForecast) : null,
      emergencyPath: futureEmergency > 0 ? proj(futureEmergency) : null,
      pessimisticPath: futurePessimistic > 0 ? proj(futurePessimistic) : null,
    };
  }, [containerW, rangeKey, totalUnits, worthBoundaries, nets, N, currentWorth, futureForecast, futureEmergency, futurePessimistic]);

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

    const futureDays = Math.max(futureForecast, futureEmergency, futurePessimistic);
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
  }, [bw, N, days, dmFmt, monthFmt, fx, futureForecast, futureEmergency, futurePessimistic]);

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
    const fcWorth =
      futureForecast > 0 && hover.unit <= N + futureForecast
        ? currentWorth * (1 - (hover.unit - N) / futureForecast)
        : null;
    const emWorth =
      futureEmergency > 0 && hover.unit <= N + futureEmergency
        ? currentWorth * (1 - (hover.unit - N) / futureEmergency)
        : null;
    const psWorth = futurePessimistic > 0 && hover.unit <= N + futurePessimistic
      ? currentWorth * (1 - (hover.unit - N) / futurePessimistic)
      : null;
    return {
      label: fullFmt.format(date),
      rows: [
        ...(fcWorth != null ? [{ color: C_FORECAST, label: "Forecast", value: money(fcWorth), y: fcWorth }] : []),
        ...(emWorth != null ? [{ color: C_EMERGENCY, label: "Reduced Spending", value: money(emWorth), y: emWorth }] : []),
        ...(psWorth != null ? [{ color: C_PESSIMISTIC, label: "Pessimistic", value: money(psWorth), y: psWorth }] : []),
      ],
    };
  }, [
    hover,
    days,
    worthBoundaries,
    nets,
    now,
    N,
    futureForecast,
    futureEmergency,
    futurePessimistic,
    currentWorth,
    fullFmt,
    money,
  ]);

  // The gross forecast burn (Pessimistic) less the net one (Forecast) is exactly
  // the periodic income assumed to offset it — so the same expenses/income/net
  // breakdown the runway tile shows can be reconstructed here without threading
  // the raw figures through the series.
  const forecastIncome =
    pessimisticMonthly != null && forecastMonthly != null ? pessimisticMonthly - forecastMonthly : null;

  const legend: LegendItem[] = [{ color: C_WORTH, label: "Available balance" }];
  if (futureForecast > 0)
    legend.push({
      color: C_FORECAST,
      dashed: true,
      label: `Forecast · ${compact.format(forecastMonthly!)}/mo`,
      popover: {
        note: "Spend if life carries on unchanged, less the periodic income that keeps covering part of it.",
        rows: [
          { label: "Forecast expenses", value: `${money(pessimisticMonthly!)}/mo` },
          { label: "Less periodic income", value: `−${money(forecastIncome!)}/mo` },
          { label: "Net burn", value: `${money(forecastMonthly!)}/mo`, emphasis: true },
        ],
      },
    });
  if (futureEmergency > 0)
    legend.push({
      color: C_EMERGENCY,
      dashed: true,
      label: `Reduced Spending · ${compact.format(emergencyMonthly!)}/mo`,
      popover: {
        note: "Essentials only — the floor if discretionary spending stops. Assumes no income arrives to offset it.",
        rows: [{ label: "Essential spend", value: `${money(emergencyMonthly!)}/mo`, emphasis: true }],
      },
    });
  if (futurePessimistic > 0)
    legend.push({
      color: C_PESSIMISTIC,
      dashed: true,
      label: `Pessimistic · ${compact.format(pessimisticMonthly!)}/mo`,
      popover: {
        note: "Spending carries on unchanged and assumes no income arrives to offset it — the harshest case.",
        rows: [{ label: "Forecast expenses", value: `${money(pessimisticMonthly!)}/mo`, emphasis: true }],
      },
    });

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
