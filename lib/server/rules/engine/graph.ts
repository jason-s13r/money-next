/**
 * A minimal, valid starter graph for a new rule document: it passes every
 * transaction Akahu already typed as a `TRANSFER` to the auto-linker, which is
 * safe because that linker only acts on an unambiguous opposite leg. Everything
 * else — category and merchant rules — is left for the author to add. Kept as a
 * value (not a file) so a fresh document opens on something runnable.
 */
export function defaultDecisionGraph(): { nodes: unknown[]; edges: unknown[] } {
  return {
    nodes: [
      {
        id: "input",
        type: "inputNode",
        name: "Transaction",
        position: { x: 100, y: 160 },
      },
      {
        id: "rules",
        type: "expressionNode",
        name: "Automations",
        position: { x: 380, y: 160 },
        content: {
          expressions: [
            // Hand transfers to the auto-linker. Add your own category/merchant
            // rules here, e.g. `categoryId: contains(lower(description), 'uber')
            // ? 'nzfcc_...' : null`.
            { id: "auto-transfer", key: "autoLinkTransfer", value: "type == 'TRANSFER'" },
          ],
        },
      },
      {
        id: "output",
        type: "outputNode",
        name: "Result",
        position: { x: 660, y: 160 },
      },
    ],
    edges: [
      { id: "e1", type: "edge", sourceId: "input", targetId: "rules" },
      { id: "e2", type: "edge", sourceId: "rules", targetId: "output" },
    ],
  };
}
