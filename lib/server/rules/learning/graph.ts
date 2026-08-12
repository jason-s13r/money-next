export const LEARNED_TABLE_ID = "learned-rules";
export const MATCH_COL = "when";
export const CATEGORY_COL = "out-category";
export const MERCHANT_COL = "out-merchant";
export const LABEL_COL = "out-label";

/** The learned table's output columns, in display order. */
const OUTPUT_COLS = [
  { id: CATEGORY_COL, name: "Category", field: "categoryId" },
  { id: MERCHANT_COL, name: "Merchant", field: "merchantId" },
  { id: LABEL_COL, name: "Label", field: "labelName" },
] as const;

export type Node = { id: string; type?: string; content?: unknown; [k: string]: unknown };
export type Edge = { id: string; sourceId: string; targetId: string; type?: string };
export type Graph = { nodes: Node[]; edges: Edge[] };

export type TableRule = Record<string, string>;
export type TableContent = {
  hitPolicy: string;
  inputs: { id: string; name: string; field?: string }[];
  outputs: { id: string; name: string; field: string }[];
  rules: TableRule[];
};

import { id } from "./id";

export function findByType(graph: Graph, type: string): Node | undefined {
  return graph.nodes.find((n) => n.type === type);
}

/** The learned-rules table node's content, or null when the graph has none. */
export function learnedTable(graph: Graph): TableContent | null {
  const node = graph.nodes.find((n) => n.id === LEARNED_TABLE_ID);
  return node ? (node.content as TableContent) : null;
}

/**
 * Bring a table up to the current column set, in place and idempotently.
 *
 * The engine skips a row outright — it does not merely drop that one output —
 * unless the row carries a key for *every* declared output column. A row written
 * with only a category was therefore never matching at all, and adding the label
 * column would have done the same to every row that predates it. So: add any
 * missing column definition, then give every row a cell for every column, empty
 * where it sets nothing.
 */
export function normalizeTable(table: TableContent): void {
  for (const col of OUTPUT_COLS) {
    if (!table.outputs.some((o) => o.id === col.id)) table.outputs.push({ ...col });
  }
  for (const rule of table.rules) {
    for (const output of table.outputs) {
      rule[output.id] ??= "";
    }
  }
}

/** Ensure the graph has the learned-rules table, wired input → table → output.
 *  Returns the table node's content, mutated in place by the caller. */
export function ensureTable(graph: Graph): TableContent {
  let node = graph.nodes.find((n) => n.id === LEARNED_TABLE_ID);
  if (!node) {
    const content: TableContent = {
      hitPolicy: "first",
      inputs: [{ id: MATCH_COL, name: "When" }],
      outputs: OUTPUT_COLS.map((c) => ({ ...c })),
      rules: [],
    };
    node = {
      id: LEARNED_TABLE_ID,
      type: "decisionTableNode",
      name: "Learned rules",
      position: { x: 380, y: 340 },
      content,
    };
    graph.nodes.push(node);

    // Wire it in parallel with the rest of the graph so its outputs merge at the
    // output node (confirmed to combine, not replace).
    const input = findByType(graph, "inputNode");
    const output = findByType(graph, "outputNode");
    if (input && !graph.edges.some((e) => e.sourceId === input.id && e.targetId === LEARNED_TABLE_ID)) {
      graph.edges.push({ id: id("edge"), type: "edge", sourceId: input.id, targetId: LEARNED_TABLE_ID });
    }
    if (output && !graph.edges.some((e) => e.sourceId === LEARNED_TABLE_ID && e.targetId === output.id)) {
      graph.edges.push({ id: id("edge"), type: "edge", sourceId: LEARNED_TABLE_ID, targetId: output.id });
    }
  }
  const content = node.content as TableContent;
  // Every writer comes through here, so every write heals the document it touches.
  normalizeTable(content);
  return content;
}
