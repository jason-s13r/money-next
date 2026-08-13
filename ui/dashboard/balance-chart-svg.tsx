"use client";

import { cn } from "@/lib/utils";
import { formatMoneyWhole } from "@/lib/format";
import {
  AXIS_W,
  type Bar,
  C_DOWN,
  C_PLANNED,
  C_UP,
  C_WORTH,
  H,
  type Hover,
  PAD_T,
  PLOT_Y1,
  type Row,
} from "./balance-chart.util";

type Scale = { min: number; max: number; ticks: number[] };

/** How close to an edge the tooltip stops being centred on the crosshair. Half a
 *  roomy box: nothing here wraps, so the box is as wide as its longest row. */
const TIP_EDGE = 90;

type Geom = {
  bw: number;
  /** The plot's width — the window fills it exactly, so nothing scrolls. */
  viewportW: number;
  yScale: Scale;
  fx: (unit: number) => number;
  fy: (v: number) => number;
  /** Null when the window has moved wholly past the end of history. */
  worthPath: string | null;
  worthArea: string | null;
  nowX: number;
  /** Only the bars the window shows: the recorded days, and the forward ones
   *  carrying the flow the forecasts plan on average. */
  historyBars: Bar[];
  plannedBars: Bar[];
  /** One dashed line per forecast budget, in legend order. */
  projections: { id: string; color: string; path: string }[];
  /** Where the credit facility bottoms out, when a projection reaches for it —
   *  `y` in plot pixels, `value` the balance it stands for. Null when there is no
   *  facility, or no line goes low enough for it to be worth marking. */
  floor: { y: number; value: number } | null;
};

type ChartSvgProps = {
  geom: Geom;
  worthBoundaries: number[];
  currentWorth: number;
  displayCurrency: string;
  /** Money in axis shorthand — see `compactMoney`. */
  compact: (value: number) => string;
  xLabels: { x: number; text: string }[];
  hover: Hover | null;
  info: { label: string; rows: Row[] } | null;
  onMove: (e: React.MouseEvent<SVGSVGElement>) => void;
  onLeave: () => void;
};

export function BalanceChartSvg({
  geom,
  worthBoundaries,
  currentWorth,
  displayCurrency,
  compact,
  xLabels,
  hover,
  info,
  onMove,
  onLeave,
}: ChartSvgProps) {
  const { bw, viewportW, fy, worthPath, worthArea, nowX } = geom;
  const money = (n: number) => formatMoneyWhole(n, displayCurrency);
  // Today is only drawn when the window is actually looking at it — a divider
  // pinned to the edge of a plot showing 2022 would be marking the wrong day.
  const nowVisible = nowX >= 0 && nowX <= viewportW;
  // The labels that hang off today follow the plot's left edge once it has
  // scrolled past, rather than being cropped along with it.
  const markX = Math.max(0, nowX);

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
            {compact(v)}
          </text>
        ))}
      </svg>

      {/* The plot — the window fills it exactly, and marks that fall outside are
          cropped by the SVG's own edges. */}
      <div className="relative min-w-0 flex-1">
        <svg
          width={viewportW}
          height={H}
          className="block"
          role="img"
          aria-label={`Available balance over time, currently ${money(
            currentWorth,
          )}, with daily net-flow bars, grey bars for the flow the forecast budgets plan on average each day ahead, and one projected line per forecast budget.${
            geom.floor
              ? ` Projections continue below zero into available credit, down to ${money(geom.floor.value)}.`
              : ""
          } Use the time window below to change the dates shown.`}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
        >
          {/* Horizontal grid */}
          {geom.yScale?.ticks.map((v: number) => (
            <line
              key={v}
              x1={0}
              x2={viewportW}
              y1={fy(v)}
              y2={fy(v)}
              style={{ stroke: v === 0 ? "var(--viz-axis)" : "var(--viz-grid)" }}
              strokeWidth={1}
            />
          ))}

          {/* Net-worth area (faint, grounds the line to zero) */}
          {worthArea && <path d={worthArea} style={{ fill: C_WORTH, opacity: 0.06 }} />}

          {/* Net-flow bars: each rises (in) or drops (out) from the $0 line by
              the day's net flow — the same amount the net-worth line steps. */}
          {geom.historyBars.map(({ key, x, value }) => {
            const active = hover?.kind === "history" && hover.i === key;
            return (
              <rect
                key={key}
                {...bar(value, x, bw, fy)}
                style={{ fill: value >= 0 ? C_UP : C_DOWN, opacity: active ? 1 : 0.9 }}
              />
            );
          })}

          {/* The same bars past today, in the planned days: one grey bar per day
              carrying the flow the forecast budgets average out to. Grey and
              faint because it is a plan — the day it is drawn in green is the day
              it is mistaken for a transaction that happened. It sits under the
              lines, like its historic half does. */}
          {geom.plannedBars.map(({ key, x, value }) => (
            <rect key={key} {...bar(value, x, bw, fy)} style={{ fill: C_PLANNED, opacity: 0.55 }} />
          ))}

          {/* Net-worth line, on top of the candles */}
          {worthPath && (
            <path d={worthPath} fill="none" style={{ stroke: C_WORTH }} strokeWidth={2} strokeLinejoin="round" />
          )}

          {/* Projections — dashed, so the plan never reads as recorded history.
              Colour is the only thing telling them apart, which is why each
              forecast budget keeps its derived colour. */}
          {geom.projections.map((p) => (
            <path
              key={p.id}
              d={p.path}
              fill="none"
              style={{ stroke: p.color }}
              strokeWidth={1}
              strokeDasharray="4 2"
              strokeLinejoin="round"
            />
          ))}

          {/* The credit floor: how far the facilities let a plan go under, drawn
              across the forecast half only, because it is today's limits being
              spent forward and says nothing about what the past could have done.
              Solid-ish and in the warning ink — unlike the projections it is not
              a guess, it is the wall they stop at. */}
          {geom.floor && nowX < viewportW && (
            <>
              <line
                x1={markX}
                x2={viewportW}
                y1={geom.floor.y}
                y2={geom.floor.y}
                style={{ stroke: C_DOWN, opacity: 0.5 }}
                strokeWidth={1}
                strokeDasharray="6 3"
              />
              <text
                x={markX + 4}
                y={geom.floor.y - 5}
                fontSize={11}
                style={{ fill: "var(--text-muted)" }}
              >
                {`credit limit · ${compact(geom.floor.value)}`}
              </text>
            </>
          )}

          {/* Today divider */}
          {nowVisible && (
            <>
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
            </>
          )}

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

        {/* Tooltip — centred on the crosshair, except within a box's width of
            either edge, where it flips to hang inside the plot instead of being
            cut off by the card. */}
        {hover && info && (
          <div
            className={cn(
              "pointer-events-none absolute top-0 z-10 rounded-md border border-current/10 bg-background px-2.5 py-1.5 text-xs shadow-sm",
              hover.x > viewportW - TIP_EDGE
                ? "-translate-x-full"
                : hover.x > TIP_EDGE && "-translate-x-1/2",
            )}
            style={{ left: hover.x }}
          >
            <p className="mb-0.5 whitespace-nowrap font-medium">{info.label}</p>
            {/* Nothing here wraps, and the box widens to whatever it holds
                instead. A budget named "family budget" broken across two lines
                costs more room than it saves, and a wrapped figure is worse than
                untidy: `-$1,240` breaking after the minus sign puts a lone "−"
                on the row above and reads as two numbers, one of them positive. */}
            {info.rows.map((r) => (
              <p
                key={r.label}
                className="flex justify-between gap-3 whitespace-nowrap font-mono tabular-nums"
              >
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

/**
 * A daily flow bar: rooted on $0, rising for money in and dropping for money
 * out, inset from its day's slot so neighbouring days stay countable.
 *
 * One function for the recorded days and the planned ones. The colour is the
 * caller's business and the only thing that differs — a plan drawn at a
 * different width or off a different baseline would be claiming to measure
 * something other than what history measures, which it isn't.
 *
 * The minimums keep a $3 day and a hair-wide zoom visible: a bar that rounds to
 * nothing looks like a day with no transactions rather than a day with small
 * ones.
 */
function bar(value: number, x: number, bw: number, fy: (v: number) => number) {
  const inset = Math.min(2.5, Math.max(0, bw * 0.15));
  const w = Math.max(0.5, bw - inset * 2);
  return {
    x: x + inset,
    y: fy(Math.max(0, value)),
    width: w,
    height: Math.max(0.6, Math.abs(fy(value) - fy(0))),
    rx: w >= 4 ? 1.5 : 0,
  };
}
