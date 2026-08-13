"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  BRUSH_H,
  BRUSH_LABEL_H,
  type BrushTick,
  C_WORTH,
  HANDLE_HIT_W,
  clampWindow,
  type Point,
  type Window,
} from "./balance-chart.util";

// The overview strip: the series at a glance, with the plot's window drawn over
// it as a draggable selection. The plot above shows only what this strip has
// selected, so this is the chart's pan and its zoom both — drag an edge to
// change how much is shown, drag the middle to move through time, drag on bare
// strip to draw a new window. History and forecast are both here, so the window
// can be pulled forward onto the projections.
//
// How much of the domain it draws is `domain`, and it is not always all of it:
// a month inside five years is a selection too thin to grab, so the strip zooms
// out around the window instead of showing everything. See `brushDomain`.

type Scenario = { id: string; color: string; points: Point[] };

type Drag =
  | { mode: "start"; from: Window }
  | { mode: "end"; from: Window }
  | { mode: "pan"; from: Window; grab: number }
  | { mode: "new"; anchor: number };

type BrushProps = {
  /** Matches the plot's width, so the strip sits under it edge to edge. */
  width: number;
  /** Days in the whole domain: history plus the furthest a projection reaches. */
  totalUnits: number;
  /** The slice of that domain this strip draws — its own frame, wider than the
   *  window and usually narrower than everything. */
  domain: Window;
  /** Where today falls in the domain — the boundary between the two halves. */
  N: number;
  worthBoundaries: number[];
  scenarios: Scenario[];
  /** The date band under the strip, stepped to suit the frame — see
   *  `brushTicks`. Positioned here, chosen there. */
  ticks: BrushTick[];
  win: Window;
  /** `settled` marks the end of a gesture: the point at which the strip may
   *  re-frame itself, which it must not do while a drag is still in hand. */
  onChange: (win: Window, settled: boolean) => void;
  /** A day-unit as a date, for the handles' screen-reader values. */
  unitLabel: (unit: number) => string;
};

export function BalanceChartBrush({
  width,
  totalUnits,
  domain,
  N,
  worthBoundaries,
  scenarios,
  ticks,
  win,
  onChange,
  unitLabel,
}: BrushProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<Window | null>(null);

  const dspan = Math.max(1e-6, domain.end - domain.start);

  const view = useMemo(() => {
    const sx = (unit: number) => ((unit - domain.start) / dspan) * width;

    // The recorded days the frame reaches over, a day either side so the line
    // enters and leaves rather than starting at the edge.
    const last = worthBoundaries.length - 1;
    const i0 = Math.max(0, Math.min(last, Math.floor(domain.start) - 1));
    const i1 = Math.max(i0, Math.min(last, Math.ceil(domain.end) + 1));

    // One y-range over what this frame draws, $0 always in it — the same rule
    // the plot's axis follows, so the two shapes are the same shape.
    let lo = 0;
    let hi = 0;
    for (let k = i0; k <= i1; k++) {
      const w = worthBoundaries[k];
      if (w < lo) lo = w;
      if (w > hi) hi = w;
    }
    for (const s of scenarios) {
      for (const p of s.points) {
        if (N + p.day < domain.start - 1 || N + p.day > domain.end + 1) continue;
        if (p.worth < lo) lo = p.worth;
        if (p.worth > hi) hi = p.worth;
      }
    }
    const sy = (v: number) => BRUSH_H - 3 - ((v - lo) / (hi - lo || 1)) * (BRUSH_H - 6);

    // At most one sample per pixel: the strip is an orientation aid, and five
    // years of daily vertices in 900px is thousands of moves nobody can see —
    // rebuilt on every resize, and read on every drag frame.
    const stride = Math.max(1, Math.ceil((i1 - i0 + 1) / Math.max(1, width)));
    const pts: string[] = [];
    for (let k = i0; k <= i1; k += stride) pts.push(`${sx(k)} ${sy(worthBoundaries[k])}`);
    if ((i1 - i0) % stride !== 0) pts.push(`${sx(i1)} ${sy(worthBoundaries[i1])}`);

    // Grounded on $0, not on the floor of the strip, like the plot's area is: an
    // area hanging *below* the zero line is the whole point of drawing one here.
    const zeroY = sy(0);
    const line = pts.length > 1 ? `M${pts.join(" L")}` : null;
    const area = line ? `${line} L${sx(i1)} ${zeroY} L${sx(i0)} ${zeroY} Z` : null;

    // Every projection, each in its own colour: picking one to stand for the
    // rest would make the strip disagree with the plot about how many futures
    // there are.
    const nowY = sy(worthBoundaries[last] ?? 0);
    const projections = scenarios
      .filter((s) => s.points.length > 0)
      .map((s) => ({
        id: s.id,
        color: s.color,
        path: `M${sx(N)} ${nowY}` + s.points.map((p) => ` L${sx(N + p.day)} ${sy(p.worth)}`).join(""),
      }));

    return { sx, zeroY, line, area, projections };
  }, [width, domain, dspan, worthBoundaries, scenarios, N]);

  const { sx } = view;
  const x0 = sx(win.start);
  const x1 = sx(win.end);

  const unitAt = useCallback(
    (clientX: number) => {
      const el = svgRef.current;
      if (!el) return domain.start;
      const rect = el.getBoundingClientRect();
      return domain.start + ((clientX - rect.left) / (rect.width || 1)) * dspan;
    },
    [domain, dspan],
  );

  // Pointer events outrun paint, and a wide window is a few thousand bars to
  // redraw, so moves are coalesced into one commit per frame.
  const commit = useCallback(
    (next: Window) => {
      pendingRef.current = next;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending) onChange(clampWindow(pending, totalUnits), false);
      });
    },
    [onChange, totalUnits],
  );

  // The end of a gesture, sent through even when the last frame already
  // rendered it: it is the only thing that lets the strip re-frame itself, and
  // holding it back would leave a zoomed window in a stale frame.
  const settle = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    onChange(clampWindow(pending ?? win, totalUnits), true);
  }, [onChange, totalUnits, win]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // Left button (or any touch/pen contact) only — a right-click should open
    // the context menu, not start dragging the window.
    if (e.button !== 0) return;
    const unit = unitAt(e.clientX);
    const x = sx(unit);

    // Whichever handle is in reach, nearest first: at the minimum width the two
    // grab zones overlap, and the far one would otherwise win by declaration
    // order and resize the window backwards.
    const dStart = Math.abs(x - x0);
    const dEnd = Math.abs(x - x1);
    const near = Math.min(dStart, dEnd) <= HANDLE_HIT_W / 2;

    if (near) {
      dragRef.current = { mode: dStart <= dEnd ? "start" : "end", from: win };
    } else if (unit > win.start && unit < win.end) {
      dragRef.current = { mode: "pan", from: win, grab: unit };
    } else {
      dragRef.current = { mode: "new", anchor: unit };
      commit({ start: unit, end: unit });
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const unit = unitAt(e.clientX);
    if (drag.mode === "start") commit({ start: unit, end: drag.from.end });
    else if (drag.mode === "end") commit({ start: drag.from.start, end: unit });
    else if (drag.mode === "new") commit({ start: drag.anchor, end: unit });
    else {
      const delta = unit - drag.grab;
      commit({ start: drag.from.start + delta, end: drag.from.end + delta });
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    settle();
  };

  // Keys settle as they go: one press is a whole gesture, and a frame that only
  // caught up on some later pointer drag would strand the keyboard reader.
  const nudge = (edge: "start" | "end", days: number) =>
    onChange(
      clampWindow(
        edge === "start"
          ? { start: win.start + days, end: win.end }
          : { start: win.start, end: win.end + days },
        totalUnits,
      ),
      true,
    );

  const onHandleKeyDown = (edge: "start" | "end") => (e: React.KeyboardEvent<SVGRectElement>) => {
    const step = e.shiftKey ? 7 : 1;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        nudge(edge, -step);
        break;
      case "ArrowRight":
      case "ArrowUp":
        nudge(edge, step);
        break;
      case "PageDown":
        nudge(edge, -30);
        break;
      case "PageUp":
        nudge(edge, 30);
        break;
      case "Home":
        onChange(
          clampWindow(edge === "start" ? { start: 0, end: win.end } : { start: win.start, end: 0 }, totalUnits),
          true,
        );
        break;
      case "End":
        onChange(
          clampWindow(
            edge === "start" ? { start: totalUnits, end: win.end } : { start: win.start, end: totalUnits },
            totalUnits,
          ),
          true,
        );
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const handle = (edge: "start" | "end", x: number) => (
    <g key={edge}>
      <rect
        x={x - 4.5}
        y={2}
        width={9}
        height={BRUSH_H - 4}
        rx={3}
        style={{ fill: "var(--background)", stroke: "var(--viz-axis)" }}
        strokeWidth={1}
      />
      {/* Grip marks — the affordance that says this one is for pulling. */}
      <line x1={x - 1.5} x2={x - 1.5} y1={BRUSH_H / 2 - 4} y2={BRUSH_H / 2 + 4} style={{ stroke: "var(--viz-axis)" }} strokeWidth={1} />
      <line x1={x + 1.5} x2={x + 1.5} y1={BRUSH_H / 2 - 4} y2={BRUSH_H / 2 + 4} style={{ stroke: "var(--viz-axis)" }} strokeWidth={1} />
      <rect
        x={x - HANDLE_HIT_W / 2}
        y={0}
        width={HANDLE_HIT_W}
        // Down to the foot of the date band: a drag starting on the dates is
        // the same drag, and the cursor should say so.
        height={BRUSH_H + BRUSH_LABEL_H}
        fill="transparent"
        className="cursor-ew-resize outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
        tabIndex={0}
        role="slider"
        aria-label={edge === "start" ? "Window start" : "Window end"}
        aria-valuemin={0}
        aria-valuemax={totalUnits}
        aria-valuenow={Math.round(win[edge])}
        aria-valuetext={unitLabel(win[edge])}
        onKeyDown={onHandleKeyDown(edge)}
      />
    </g>
  );

  return (
    <svg
      ref={svgRef}
      width={width}
      height={BRUSH_H + BRUSH_LABEL_H}
      className="block cursor-crosshair select-none"
      // Without this a touch drag scrolls the page instead of moving the window.
      style={{ touchAction: "none" }}
      aria-label="Time window. Drag the edges to change how much of the chart above is shown, or the middle to move through time."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <rect x={0} y={0} width={width} height={BRUSH_H} rx={4} style={{ fill: "var(--viz-grid)", opacity: 0.35 }} />

      {/* $0, in the plot's axis ink: without it the strip is a shape with no
          sign, and a balance under water looks the same as one above it. It is
          the strip's only gridline — the frame is about when, not how much. */}
      <line
        x1={0}
        x2={width}
        y1={view.zeroY}
        y2={view.zeroY}
        style={{ stroke: "var(--viz-axis)", opacity: 0.5 }}
        strokeWidth={1}
      />

      {view.area && <path d={view.area} style={{ fill: C_WORTH, opacity: 0.12 }} />}
      {view.line && <path d={view.line} fill="none" style={{ stroke: C_WORTH, opacity: 0.7 }} strokeWidth={1} />}
      {view.projections.map((p) => (
        <path
          key={p.id}
          d={p.path}
          fill="none"
          style={{ stroke: p.color, opacity: 0.7 }}
          strokeWidth={1}
          strokeDasharray="3 2"
        />
      ))}

      {/* Today, the same dotted divider the plot draws. */}
      <line
        x1={sx(N)}
        x2={sx(N)}
        y1={0}
        y2={BRUSH_H}
        style={{ stroke: "var(--viz-axis)" }}
        strokeWidth={1}
        strokeDasharray="2 3"
      />

      {/* What is not selected, dimmed — the selection reads as a hole cut in the
          cover rather than as a box drawn on top, which is what makes the strip
          legible as "you are looking at this part". */}
      <rect x={0} y={0} width={Math.max(0, x0)} height={BRUSH_H} style={{ fill: "var(--background)", opacity: 0.6 }} />
      <rect x={x1} y={0} width={Math.max(0, width - x1)} height={BRUSH_H} style={{ fill: "var(--background)", opacity: 0.6 }} />
      <rect
        x={x0}
        y={0}
        width={Math.max(0, x1 - x0)}
        height={BRUSH_H + BRUSH_LABEL_H}
        className="cursor-grab active:cursor-grabbing"
        style={{ fill: "var(--viz-track)", opacity: 0.22 }}
      />

      {/* The date band, drawn last of the flat marks so the dimming above never
          washes it out: the dates outside the window are exactly the ones being
          read to decide where to drag to. */}
      <g aria-hidden="true">
        {ticks.map((t) => {
          const x = sx(t.unit);
          return (
            <g key={t.unit}>
              <line
                x1={x}
                x2={x}
                y1={BRUSH_H - (t.rank > 0 ? 5 : 3)}
                y2={BRUSH_H}
                style={{ stroke: "var(--viz-axis)", opacity: t.rank > 0 ? 0.6 : 0.35 }}
                strokeWidth={1}
              />
              {/* Text only where the whole of it fits: a half-label cropped by
                  the edge of the strip reads as a different date. */}
              {x >= 18 && x <= width - 18 && (
                <text
                  x={x}
                  y={BRUSH_H + 11}
                  textAnchor="middle"
                  fontSize={10}
                  style={{ fill: "var(--text-muted)", opacity: t.rank > 0 ? 1 : 0.75 }}
                >
                  {t.text}
                </text>
              )}
            </g>
          );
        })}
      </g>

      {handle("start", x0)}
      {handle("end", x1)}
    </svg>
  );
}
