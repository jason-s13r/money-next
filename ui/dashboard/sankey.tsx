"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatMoneyWhole } from "@/lib/format";
import type { SankeyData, SankeyNode } from "@/lib/sankey";
import { DEPTH, OTHER_BUCKETS, SAVINGS, compareIncome, compareSpendGroup } from "@/lib/sankey";

// A hand-rolled Sankey diagram. No external chart library is used in this project,
// so the layout is computed locally with a simple depth-based algorithm:
// nodes are grouped into columns by depth, sorted top-to-bottom by value, and
// links are drawn as cubic beziers whose thickness is proportional to the value.
//
// The diagram is responsive: it measures its container and scales the SVG to fit.

const PAD = { top: 12, right: 12, bottom: 12, left: 12 };
const NODE_WIDTH = 16;
const NODE_GAP = 18;
const MIN_LINK_HEIGHT = 2;
/**
 * Every label is written in the gap to the left of its own node, so each gap
 * belongs to exactly one column and no two columns can write over each other.
 * The leftmost column has no gap to its left, so this margin is reserved for it.
 */
const LABEL_SPACE = 110;
const LABEL_INSET = 6;
const LABEL_FONT = 11;
const VALUE_FONT = 10;
/** Rough advance width per character, as a fraction of font size. */
const CHAR_WIDTH_RATIO = 0.52;

/** Trim to what will actually fit, so a long name can't run into the column beside it. */
function truncateToWidth(text: string, fontSize: number, maxWidth: number): string {
  const maxChars = Math.floor(maxWidth / (fontSize * CHAR_WIDTH_RATIO));
  if (maxChars < 1) return "";
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** Real nodes first, then "Other …", then Savings — the flow's terminus. */
function bucketRank(n: SankeyNode): number {
  if (n.label === SAVINGS) return 2;
  return OTHER_BUCKETS.has(n.label) ? 1 : 0;
}

/**
 * Order a column by the weighted average position of the nodes it links to in an
 * already-ordered neighbouring column — its "barycenter". This is what keeps a
 * node in the lane of whatever it trades with, instead of letting a large but
 * unrelated node elsewhere push it out of line.
 *
 * `edge` picks which end of a link points at the neighbour: every column reads
 * from the column to its left, except the leftmost, which has nothing to its
 * left and so reads rightward from the one it feeds.
 */
function orderByBarycenter(
  column: SankeyNode[],
  neighbour: SankeyNode[],
  links: SankeyData["links"],
  edge: (l: SankeyData["links"][number]) => { near: string; far: string },
): SankeyNode[] {
  const rank = new Map(neighbour.map((n, i) => [n.id, i]));
  const weightedSum = new Map<string, number>();
  const weight = new Map<string, number>();
  for (const l of links) {
    const { near, far } = edge(l);
    const r = rank.get(far);
    if (r === undefined) continue;
    weightedSum.set(near, (weightedSum.get(near) ?? 0) + r * l.value);
    weight.set(near, (weight.get(near) ?? 0) + l.value);
  }
  // A node with no link to the neighbouring column has no lane to sit in — it
  // falls to the bottom rather than pretending to a position.
  const barycenter = (n: SankeyNode) => {
    const w = weight.get(n.id) ?? 0;
    return w > 0 ? (weightedSum.get(n.id) ?? 0) / w : Infinity;
  };
  return column.toSorted(
    (a, b) => bucketRank(a) - bucketRank(b) || barycenter(a) - barycenter(b) || b.value - a.value,
  );
}

function sankeyLayout(
  data: SankeyData,
  width: number,
  height: number,
): {
  nodes: (SankeyNode & { x: number; y: number; h: number })[];
  links: {
    source: SankeyNode & { x: number; y: number; h: number };
    target: SankeyNode & { x: number; y: number; h: number };
    value: number;
    path: string;
    h: number;
  }[];
  contentHeight: number;
  columnWidth: number;
} {
  if (data.nodes.length === 0 || width < 100 || height < 100) {
    return { nodes: [], links: [], contentHeight: 0, columnWidth: 0 };
  }

  const maxDepth = Math.max(0, ...data.nodes.map((n) => n.depth));
  // Only the left margin is reserved: labels never sit to the right of a node.
  const plotW = Math.max(100, width - PAD.left - PAD.right - LABEL_SPACE);
  const columnCount = maxDepth + 1;
  const columnWidth = (plotW - NODE_WIDTH) / Math.max(1, columnCount - 1);

  const columns: SankeyNode[][] = [];
  for (let d = 0; d <= maxDepth; d++) {
    columns[d] = data.nodes.filter((n) => n.depth === d);
  }

  // Two columns carry an order that value alone can't express, so it is stated
  // outright — and stated once, in the adapter, which pairs income to spend in
  // this same order when it builds the links.
  columns[DEPTH.incomeSubcategory] = (columns[DEPTH.incomeSubcategory] ?? []).toSorted(compareIncome);
  columns[DEPTH.spendGroup] = (columns[DEPTH.spendGroup] ?? []).toSorted(compareSpendGroup);

  // Every other column takes its order from its neighbour, so each node sits in
  // the lane of whatever it trades with. The income merchants read rightward
  // from the income they pay into; everything downstream reads leftward from
  // what feeds it.
  columns[DEPTH.incomeMerchant] = orderByBarycenter(
    columns[DEPTH.incomeMerchant] ?? [],
    columns[DEPTH.incomeSubcategory] ?? [],
    data.links,
    (l) => ({ near: l.source, far: l.target }),
  );
  for (let d = DEPTH.spendSubcategory; d <= maxDepth; d++) {
    columns[d] = orderByBarycenter(columns[d], columns[d - 1], data.links, (l) => ({
      near: l.target,
      far: l.source,
    }));
  }

  // Use a single global scale so link thickness is consistent across columns.
  // The scale is based on a target aspect ratio (width * 0.55), but the actual
  // SVG height grows naturally to fit all nodes without squashing.
  const columnTotals = columns.map((col) =>
    col.reduce((sum, n) => sum + n.value, 0),
  );
  const maxColumnTotal = Math.max(0, ...columnTotals);
  const targetPlotH = Math.max(80, width * 0.55 - PAD.top - PAD.bottom);
  const globalScale = maxColumnTotal > 0 ? targetPlotH / maxColumnTotal : 0;

  const SAVINGS_EXTRA_MARGIN = 24;

  // Position is carried through, not restacked. Aligning columns as blocks — all
  // tops level, or all centres level — picks one offset for a whole column and so
  // can only ever suit some of the nodes in it. Instead each node is drawn to the
  // weighted centre of whatever it trades with, so a flow keeps its height across
  // the diagram, and a column only intervenes where two nodes want the same space.

  const heightOf = (n: SankeyNode) => Math.max(2, n.value * globalScale);
  /** Savings asks for extra air above it, wherever it ends up. */
  const spaceAbove = (n: SankeyNode) => (n.label === SAVINGS ? SAVINGS_EXTRA_MARGIN : 0);

  type Placed = SankeyNode & { y: number; h: number };

  // Seed every column stacked from the top; the passes below move it from there.
  const placed: Placed[][] = columns.map((col) => {
    const out: Placed[] = [];
    let y = PAD.top;
    for (const n of col) {
      y += spaceAbove(n);
      const h = heightOf(n);
      out.push({ ...n, y, h });
      y += h + NODE_GAP;
    }
    return out;
  });

  const byId = new Map(placed.flat().map((n) => [n.id, n]));
  type Neighbour = { node: Placed; value: number };
  const inbound = new Map<string, Neighbour[]>();
  const outbound = new Map<string, Neighbour[]>();
  const add = (m: Map<string, Neighbour[]>, key: string, n: Neighbour) => {
    const list = m.get(key);
    if (list) list.push(n);
    else m.set(key, [n]);
  };
  for (const l of data.links) {
    const source = byId.get(l.source);
    const target = byId.get(l.target);
    if (!source || !target) continue;
    add(outbound, l.source, { node: target, value: l.value });
    add(inbound, l.target, { node: source, value: l.value });
  }

  const centre = (n: Placed) => n.y + n.h / 2;

  // What a column needs if simply stacked, and so the least room it can be given.
  // The tallest such column sets the extent every column settles inside: no
  // arrangement of nodes can be shorter than that, and none should be taller.
  const naturalHeight = (col: Placed[]) =>
    col.reduce((h, n, i) => h + n.h + (i > 0 ? NODE_GAP : 0) + spaceAbove(n), 0);
  const extent = Math.max(0, ...placed.map(naturalHeight));
  const ceiling = PAD.top;
  const floorLimit = PAD.top + extent;

  /**
   * The interference case: two nodes wanting the same space. Push them apart in
   * the column's established order, which is a domain rule (essentials first,
   * Savings last) and outranks whatever position a neighbour would like.
   *
   * Both directions, not just down. Pushing only downward means every collision
   * settles by growing the column, and the diagram sprawls to make room it didn't
   * need; coming back up off the floor keeps it inside the extent.
   */
  const separate = (col: Placed[]) => {
    let floor = ceiling;
    for (const n of col) {
      n.y = Math.max(n.y, floor + spaceAbove(n));
      floor = n.y + n.h + NODE_GAP;
    }
    let roof = floorLimit;
    for (let i = col.length - 1; i >= 0; i--) {
      const n = col[i];
      n.y = Math.min(n.y, roof - n.h);
      roof = n.y - NODE_GAP - spaceAbove(n);
    }
  };

  /** Draw each node to the weighted centre of what it links to on one side. */
  const align = (col: Placed[], side: Map<string, Neighbour[]>) => {
    for (const n of col) {
      const links = side.get(n.id);
      if (!links) continue;
      const weight = links.reduce((sum, l) => sum + l.value, 0);
      if (weight <= 0) continue;
      n.y = links.reduce((sum, l) => sum + centre(l.node) * l.value, 0) / weight - n.h / 2;
    }
    separate(col);
  };

  // Sweep right, then left, until it settles. This is a strict layered DAG, so a
  // handful of passes is plenty — there are no cycles to oscillate around.
  for (let pass = 0; pass < 6; pass++) {
    for (let d = 1; d <= maxDepth; d++) align(placed[d], inbound);
    for (let d = maxDepth - 1; d >= 0; d--) align(placed[d], outbound);
  }

  const positioned: (SankeyNode & { x: number; y: number; h: number })[] = placed.flat().map((n) => ({
    ...n,
    x: PAD.left + LABEL_SPACE + n.depth * columnWidth,
  }));

  const nodeById = new Map(positioned.map((n) => [n.id, n]));

  // Compute link paths. Each link leaves the right side of its source node and
  // enters the left side of its target. We stack outgoing/incoming links at each
  // node so they don't overlap.
  const sourceOffset = new Map<string, number>();
  const targetOffset = new Map<string, number>();

  // Sort links by source node position first (top-to-bottom), then by target
  // node position (top-to-bottom) within each source. This prevents links from
  // a single source crossing over each other — a link to a higher target
  // always exits higher on the source node than a link to a lower target.
  const sortedLinks = data.links.toSorted((a, b) => {
    const sourceA = nodeById.get(a.source);
    const sourceB = nodeById.get(b.source);
    const targetA = nodeById.get(a.target);
    const targetB = nodeById.get(b.target);
    if (!sourceA || !sourceB || !targetA || !targetB) return 0;
    if (sourceA.y !== sourceB.y) return sourceA.y - sourceB.y;
    return targetA.y - targetB.y;
  });

  const links = sortedLinks.map((l) => {
    const source = nodeById.get(l.source);
    const target = nodeById.get(l.target);
    if (!source || !target) return null;

    const linkH = Math.max(MIN_LINK_HEIGHT, l.value * globalScale);

    const so = sourceOffset.get(source.id) ?? 0;
    const to = targetOffset.get(target.id) ?? 0;
    sourceOffset.set(source.id, so + linkH);
    targetOffset.set(target.id, to + linkH);

    const y1 = source.y + so + linkH / 2;
    const y2 = target.y + to + linkH / 2;
    const x1 = source.x + NODE_WIDTH;
    const x2 = target.x;
    const cp1x = x1 + (x2 - x1) / 2;
    const cp2x = x2 - (x2 - x1) / 2;

    const path = `M ${x1} ${y1} C ${cp1x} ${y1}, ${cp2x} ${y2}, ${x2} ${y2}`;

    return {
      source,
      target,
      value: l.value,
      path,
      h: linkH,
    };
  }).filter(Boolean) as {
    source: SankeyNode & { x: number; y: number; h: number };
    target: SankeyNode & { x: number; y: number; h: number };
    value: number;
    path: string;
    h: number;
  }[];

  const maxBottom = Math.max(0, ...positioned.map((n) => n.y + n.h));
  const contentHeight = maxBottom + PAD.bottom;

  return { nodes: positioned, links, contentHeight, columnWidth };
}

function SankeyNodeLabel({
  node,
  displayCurrency,
  laneWidth,
}: {
  node: SankeyNode & { x: number; y: number; h: number };
  displayCurrency: string;
  /** How much room this node's label has before it would reach the column beside it. */
  laneWidth: number;
}) {
  const labelX = node.x - LABEL_INSET;
  const textY = node.y + node.h / 2;
  const available = laneWidth - LABEL_INSET * 2;
  const shown = truncateToWidth(node.label, LABEL_FONT, available);

  return (
    <g>
      <text
        x={labelX}
        y={textY}
        textAnchor="end"
        dominantBaseline="middle"
        fontSize={LABEL_FONT}
        style={{ fill: "var(--foreground)" }}
      >
        {shown !== node.label ? <title>{node.label}</title> : null}
        {shown}
      </text>
      <text
        x={labelX}
        y={textY + 13}
        textAnchor="end"
        dominantBaseline="middle"
        fontSize={VALUE_FONT}
        style={{ fill: "var(--text-muted)" }}
      >
        {formatMoneyWhole(node.value, displayCurrency)}
      </text>
    </g>
  );
}

export function SankeyDiagram({
  data,
  displayCurrency,
  title,
}: {
  data: SankeyData;
  displayCurrency: string;
  title?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // Measure container on mount and resize. useLayoutEffect so the first paint
  // already has real dimensions; a ResizeObserver covers container resizes.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const measured = Math.max(320, rect.width > 0 ? rect.width : el.clientWidth);
      // Height is derived from width, so width is the only real input. Bail when it
      // hasn't moved: the observer fires for changes this layout doesn't care about,
      // and every accepted measurement re-sorts every column.
      setSize((prev) =>
        prev.width === measured
          ? prev
          : { width: measured, height: Math.max(240, measured * 0.55) },
      );
    };
    // Defer first measure so the container has been laid out by the parent.
    const id = requestAnimationFrame(update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
    };
  }, []);

  const { nodes, links, contentHeight, columnWidth } = useMemo(
    () => sankeyLayout(data, size.width, size.height),
    [data, size.width, size.height],
  );

  const empty = nodes.length === 0 || size.width === 0;

  return (
    <div ref={containerRef} className="w-full">
      {title ? <p className="mb-2 text-sm font-medium">{title}</p> : null}
      {empty ? (
        <div className="rounded-lg border border-current/10 p-4 text-sm text-muted">
          <p>No money flows to display for this period.</p>
        </div>
      ) : (
        <svg
          width={size.width}
          height={Math.max(size.height, contentHeight)}
          className="block"
          role="img"
          aria-label={title ? `${title}: money flow diagram` : "Money flow diagram"}
        >
        <defs>
          {links.map((l, i) => {
            const id = `link-gradient-${i}`;
            return (
              <linearGradient key={id} id={id} gradientUnits="userSpaceOnUse" x1={l.source.x} x2={l.target.x}>
                <stop offset="0%" stopColor={l.source.color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={l.target.color} stopOpacity={0.35} />
              </linearGradient>
            );
          })}
        </defs>

        {links.map((l, i) => (
          <path
            key={`${l.source.id}-${l.target.id}-${i}`}
            d={l.path}
            fill="none"
            stroke={`url(#link-gradient-${i})`}
            strokeWidth={l.h}
            strokeLinecap="butt"
          />
        ))}

        {nodes.map((n) => (
          <g key={n.id}>
            <rect
              x={n.x}
              y={n.y}
              width={NODE_WIDTH}
              height={n.h}
              rx={2}
              style={{ fill: n.color }}
            />
            <SankeyNodeLabel
              node={n}
              displayCurrency={displayCurrency}
              laneWidth={n.depth === 0 ? LABEL_SPACE : columnWidth - NODE_WIDTH}
            />
          </g>
        ))}
        </svg>
      )}
    </div>
  );
}


