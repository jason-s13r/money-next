export const LEARNED_TABLE_ID = "learned-rules";
export const MATCH_COL = "when";
export const CATEGORY_COL = "out-category";
export const MERCHANT_COL = "out-merchant";

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

/** Ensure the graph has the learned-rules table, wired input → table → output.
 *  Returns the table node's content, mutated in place by the caller. */
export function ensureTable(graph: Graph): TableContent {
  let node = graph.nodes.find((n) => n.id === LEARNED_TABLE_ID);
  if (!node) {
    const content: TableContent = {
      hitPolicy: "first",
      inputs: [{ id: MATCH_COL, name: "When" }],
      outputs: [
        { id: CATEGORY_COL, name: "Category", field: "categoryId" },
        { id: MERCHANT_COL, name: "Merchant", field: "merchantId" },
      ],
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
  return node.content as TableContent;
}
