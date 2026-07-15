"use client";

import { formatMoneyWhole } from "@/lib/format";
import { formatPeriodKey } from "@/lib/periods";
import {
  AXIS_W,
  C_DOWN,
  C_EMERGENCY,
  C_FORECAST,
  C_PESSIMISTIC,
  C_UP,
  C_WORTH,
  DAY_MS,
  H,
  type Hover,
  PAD_T,
  PLOT_Y1,
  type Row,
} from "./balance-chart.util";

type Scale = { min: number; max: number; ticks: number[] };

type Geom = {
  bw: number;
  plotW: number;
  yScale: Scale;
  fx: (unit: number) => number;
  fy: (v: number) => number;
  worthPath: string;
  worthArea: string;
  nowX: number;
  forecastPath: string | null;
  emergencyPath: string | null;
  pessimisticPath: string | null;
};

type ChartSvgProps = {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  geom: Geom;
  days: string[];
  nets: number[];
  worthBoundaries: number[];
  currentWorth: number;
  now: number;
  futureForecast: number;
  futureEmergency: number;
  futurePessimistic: number;
  displayCurrency: string;
  compact: Intl.NumberFormat;
  xLabels: { x: number; text: string }[];
  hover: Hover | null;
  info: { label: string; rows: Row[] } | null;
  onMove: (e: React.MouseEvent<SVGSVGElement>) => void;
  onLeave: () => void;
};

export function BalanceChartSvg({
  scrollRef,
  geom,
  days,
  nets,
  worthBoundaries,
  currentWorth,
  now,
  futureForecast,
  futureEmergency,
  futurePessimistic,
  displayCurrency,
  compact,
  xLabels,
  hover,
  info,
  onMove,
  onLeave,
}: ChartSvgProps) {
  const { bw, plotW, fx, fy, worthPath, worthArea, nowX } = geom;
  const money = (n: number) => formatMoneyWhole(n, displayCurrency);

  return (
    <div className="flex">
      {/* Pinned y-axis — stays put while the plot scrolls. */}
      <svg width={AXIS_W} height={H} className="shrink-0" aria-hidden="true">
        {geom.yScale?.ticks.map((v: number) => (
          <text
            key={v}
            x={AXIS_W - 6}
            y={fy(v) + 4}
            textAnchor="end"
            fontSize={11}
            style={{ fill: "var(--text-muted)" }}
          >
            {compact.format(v)}
          </text>
        ))}
      </svg>

      {/* Scrollable plot */}
      <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-x-auto">
        <svg
          width={plotW}
          height={H}
          className="block"
          role="img"
          aria-label={`Available balance over time, currently ${money(
            currentWorth,
          )}, with daily net-flow bars and forecast and emergency burn-rate projections. Scroll horizontally for history.`}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
        >
          {/* Horizontal grid */}
          {geom.yScale?.ticks.map((v: number) => (
            <line
              key={v}
              x1={0}
              x2={plotW}
              y1={fy(v)}
              y2={fy(v)}
              style={{ stroke: v === 0 ? "var(--viz-axis)" : "var(--viz-grid)" }}
              strokeWidth={1}
            />
          ))}

          {/* Net-worth area (faint, grounds the line to zero) */}
          <path d={worthArea} style={{ fill: C_WORTH, opacity: 0.06 }} />

          {/* Net-flow bars: each rises (in) or drops (out) from the $0 line by
              the day's net flow — the same amount the net-worth line steps. */}
          {nets.map((value, i) => {
            const inset = Math.min(2.5, Math.max(0, bw * 0.15));
            const w = Math.max(0.5, bw - inset * 2);
            const y = fy(Math.max(0, value));
            const barH = Math.max(0.6, Math.abs(fy(value) - fy(0)));
            const active = hover?.kind === "history" && hover.i === i;
            return (
              <rect
                key={i}
                x={fx(i) + inset}
                y={y}
                width={w}
                height={barH}
                rx={w >= 4 ? 1.5 : 0}
                style={{ fill: value >= 0 ? C_UP : C_DOWN, opacity: active ? 1 : 0.9 }}
              />
            );
          })}

          {/* Net-worth line, on top of the candles */}
          <path d={worthPath} fill="none" style={{ stroke: C_WORTH }} strokeWidth={2} strokeLinejoin="round" />

          {/* Projections */}
          {geom.forecastPath && (
            <path d={geom.forecastPath} fill="none" style={{ stroke: C_FORECAST }} strokeWidth={1} strokeDasharray="4 2" />
          )}
          {geom.emergencyPath && (
            <path d={geom.emergencyPath} fill="none" style={{ stroke: C_EMERGENCY }} strokeWidth={1} strokeDasharray="2 3" />
          )}
          {geom.pessimisticPath && (
            <path d={geom.pessimisticPath} fill="none" style={{ stroke: C_PESSIMISTIC }} strokeWidth={1} strokeDasharray="2 3" />
          )}

          {/* Today divider */}
          <line
            x1={nowX}
            x2={nowX}
            y1={PAD_T}
            y2={PLOT_Y1}
            style={{ stroke: "var(--viz-axis)" }}
            strokeWidth={1}
            strokeDasharray="2 3"
          />
          <text x={nowX + 4} y={PAD_T + 11} fontSize={11} style={{ fill: "var(--text-muted)" }}>
            today
          </text>

          {/* x-axis date labels */}
          {xLabels.map((l, idx) => (
            <text
              key={idx}
              x={l.x}
              y={PLOT_Y1 + 15}
              textAnchor="middle"
              fontSize={11}
              style={{ fill: "var(--text-muted)" }}
            >
              {l.text}
            </text>
          ))}

          {/* Crosshair + point(s) */}
          {hover && info && (
            <>
              <line
                x1={hover.x}
                x2={hover.x}
                y1={PAD_T}
                y2={PLOT_Y1}
                style={{ stroke: "var(--viz-axis)" }}
                strokeWidth={1}
              />
              {hover.kind === "history" && (
                <circle
                  cx={hover.x}
                  cy={fy(worthBoundaries[hover.i + 1])}
                  r={4}
                  style={{ fill: C_WORTH, stroke: "var(--background)" }}
                  strokeWidth={2}
                />
              )}
              {hover.kind === "future" &&
                info.rows.map((r) =>
                  typeof r.y === "number" ? (
                    <circle
                      key={r.label}
                      cx={hover.x}
                      cy={fy(r.y)}
                      r={4}
                      style={{ fill: r.color, stroke: "var(--background)" }}
                      strokeWidth={2}
                    />
                  ) : null,
                )}
            </>
          )}
        </svg>

        {/* Tooltip — inside the scroller, so it tracks the crosshair as it scrolls */}
        {hover && info && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-current/10 bg-background px-2.5 py-1.5 text-xs shadow-sm"
            style={{ left: hover.x }}
          >
            <p className="mb-0.5 whitespace-nowrap font-medium">{info.label}</p>
            {info.rows.map((r) => (
              <p key={r.label} className="flex justify-between gap-3 font-mono tabular-nums">
                <span style={{ color: r.color }}>{r.label}</span>
                <span>{r.value}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
