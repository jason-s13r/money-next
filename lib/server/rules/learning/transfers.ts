import { findByType, type Graph, type Node } from "./graph";
import { id as makeId } from "./id";

const TRANSFER_KEY = "autoLinkTransfer";
const TRANSFER_ON = "type == 'TRANSFER'";

type ExprContent = { expressions: { id: string; key: string; value: string }[] };

function transferExprNode(graph: Graph): Node | undefined {
  return graph.nodes.find(
    (n) =>
      n.type === "expressionNode" &&
      ((n.content as ExprContent | undefined)?.expressions ?? []).some((e) => e.key === TRANSFER_KEY),
  );
}

export function readTransferAutoLink(graph: Graph): boolean {
  const node = transferExprNode(graph);
  if (!node) return false;
  const expr = (node.content as ExprContent).expressions.find((e) => e.key === TRANSFER_KEY);
  return expr?.value === TRANSFER_ON;
}

/** Turn transfer auto-linking on or off, creating the expression node (wired
 *  input → node → output) if the graph doesn't have one yet. */
export function setTransferAutoLink(graph: Graph, enabled: boolean): void {
  let node = transferExprNode(graph);
  if (!node) {
    node = {
      id: makeId("expr"),
      type: "expressionNode",
      name: "Transfers",
      position: { x: 380, y: 160 },
      content: { expressions: [{ id: makeId("e"), key: TRANSFER_KEY, value: "false" }] },
    };
    graph.nodes.push(node);
    const input = findByType(graph, "inputNode");
    const output = findByType(graph, "outputNode");
    if (input) graph.edges.push({ id: makeId("edge"), type: "edge", sourceId: input.id, targetId: node.id });
    if (output) graph.edges.push({ id: makeId("edge"), type: "edge", sourceId: node.id, targetId: output.id });
  }
  const expr = (node.content as ExprContent).expressions.find((e) => e.key === TRANSFER_KEY)!;
  expr.value = enabled ? TRANSFER_ON : "false";
}
