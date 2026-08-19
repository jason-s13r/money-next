import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ZenEngine } from "@gorules/zen-engine";

import {
  CATEGORY_COL,
  LABEL_COL,
  LEARNED_TABLE_ID,
  MATCH_COL,
  MERCHANT_COL,
  normalizeTable,
  type Graph,
  type TableContent,
  type TableRule,
} from "../lib/server/rules/learning/graph";
import { buildExpression, deriveMatch, normalizeToken } from "../lib/server/rules/learning/match";
import { parseMatch, readLearnedRules } from "../lib/server/rules/learning/read";
import { updateLearnedRule, validateEdit } from "../lib/server/rules/learning/edit";
import { upsertLearnedRule } from "../lib/server/rules/learning/upsert";

/**
 * Learned rules, evaluated for real. No network and no database: the graph is a
 * plain JSON value and the Zen engine is an in-process native addon, so the one
 * thing worth testing here — that a rule the app *stores* is a rule the engine
 * actually *fires* — can be tested end to end without either.
 *
 * That gap is the reason this file exists. Every rule a person taught from a
 * transaction with a category but no merchant was stored as a row the engine
 * silently skipped, while the /rules page went on listing it as if it worked,
 * because the page reads the predicate and never asks the engine anything.
 */

const graphWith = (rules: TableRule[], outputs?: TableContent["outputs"]): Graph => ({
  nodes: [
    { id: "input", type: "inputNode", name: "Transaction", position: { x: 0, y: 0 } },
    {
      id: LEARNED_TABLE_ID,
      type: "decisionTableNode",
      name: "Learned rules",
      position: { x: 200, y: 0 },
      content: {
        hitPolicy: "first",
        inputs: [{ id: MATCH_COL, name: "When" }],
        outputs: outputs ?? [
          { id: CATEGORY_COL, name: "Category", field: "categoryId" },
          { id: MERCHANT_COL, name: "Merchant", field: "merchantId" },
        ],
        rules,
      } satisfies TableContent,
    },
    { id: "output", type: "outputNode", name: "Result", position: { x: 400, y: 0 } },
  ],
  edges: [
    { id: "e1", type: "edge", sourceId: "input", targetId: LEARNED_TABLE_ID },
    { id: "e2", type: "edge", sourceId: LEARNED_TABLE_ID, targetId: "output" },
  ],
});

const table = (graph: Graph) =>
  graph.nodes.find((n) => n.id === LEARNED_TABLE_ID)!.content as TableContent;

/** Evaluate a graph against one transaction, exactly as `runRules` does. */
async function evaluate(graph: Graph, tx: { type: string; description: string }) {
  const engine = new ZenEngine();
  try {
    const decision = engine.createDecision(JSON.parse(JSON.stringify(graph)));
    const response = await decision.evaluate(tx);
    return (response.result ?? {}) as Record<string, unknown>;
  } finally {
    engine.dispose();
  }
}

const VENSA = "type == 'DEBIT' and contains(lower(description), 'vensa')";
const TX = { type: "DEBIT", description: "EFTPOS 3CB-KENSINGTONH PENROSE VENSA" };

describe("a rule that sets one field", () => {
  test("is skipped by the engine when the other column's cell is missing", async () => {
    // The bug, kept as a test so the fix cannot be undone by accident. Note what
    // the engine does: not "matched, set nothing" but no match at all.
    const graph = graphWith([{ _id: "row_a", [MATCH_COL]: VENSA, [CATEGORY_COL]: "'cat_1'" }]);
    assert.deepEqual(await evaluate(graph, TX), {});
  });

  test("fires once the table is normalized", async () => {
    const graph = graphWith([{ _id: "row_a", [MATCH_COL]: VENSA, [CATEGORY_COL]: "'cat_1'" }]);
    normalizeTable(table(graph));
    assert.deepEqual(await evaluate(graph, TX), { categoryId: "cat_1" });
  });

  test("is written with every cell present", () => {
    const graph = graphWith([]);
    const match = deriveMatch(TX)!;
    upsertLearnedRule(graph, match, { categoryId: "cat_1" });

    const row = table(graph).rules[0];
    assert.equal(row[CATEGORY_COL], "'cat_1'");
    assert.equal(row[MERCHANT_COL], "");
    assert.equal(row[LABEL_COL], "");
  });
});

describe("normalizeTable", () => {
  test("adds the label column and back-fills every row", () => {
    const graph = graphWith([{ _id: "row_a", [MATCH_COL]: VENSA, [CATEGORY_COL]: "'cat_1'" }]);
    normalizeTable(table(graph));

    assert.deepEqual(
      table(graph).outputs.map((o) => o.id),
      [CATEGORY_COL, MERCHANT_COL, LABEL_COL],
    );
    assert.deepEqual(table(graph).rules[0], {
      _id: "row_a",
      [MATCH_COL]: VENSA,
      [CATEGORY_COL]: "'cat_1'",
      [MERCHANT_COL]: "",
      [LABEL_COL]: "",
    });
  });

  test("is idempotent, and leaves cells that are already set alone", () => {
    const graph = graphWith([
      { _id: "row_a", [MATCH_COL]: VENSA, [CATEGORY_COL]: "'cat_1'", [MERCHANT_COL]: "'mer_1'" },
    ]);
    normalizeTable(table(graph));
    const once = JSON.stringify(table(graph));
    normalizeTable(table(graph));
    assert.equal(JSON.stringify(table(graph)), once);
  });
});

describe("buildExpression", () => {
  test("round-trips through parseMatch", () => {
    const parsed = parseMatch(buildExpression("DEBIT", ["vensa", "penrose"]));
    assert.equal(parsed.type, "DEBIT");
    assert.deepEqual(parsed.tokens, ["vensa", "penrose"]);
  });

  test("omits the type clause when the rule matches any type", () => {
    const expression = buildExpression(null, ["vensa"]);
    assert.equal(expression, "contains(lower(description), 'vensa')");
    assert.equal(parseMatch(expression).type, null);
  });
});

describe("normalizeToken", () => {
  test("trims and lowercases", () => {
    assert.equal(normalizeToken("  Vensa "), "vensa");
  });

  test("rejects empty, and anything that would break out of the literal", () => {
    assert.equal(normalizeToken("   "), null);
    assert.equal(normalizeToken("o'brien"), null);
  });
});

describe("validateEdit", () => {
  const base = { type: "DEBIT", categoryId: "cat_1", merchantId: null, labelName: null };

  test("normalizes and de-duplicates tokens", () => {
    const result = validateEdit({ ...base, tokens: [" Vensa ", "VENSA", "penrose"] });
    assert.ok(result.ok);
    assert.deepEqual(result.edit.tokens, ["vensa", "penrose"]);
  });

  test("refuses a rule with nothing to match on", () => {
    const result = validateEdit({ ...base, tokens: ["  "] });
    assert.equal(result.ok, false);
  });

  test("refuses a rule that sets neither a category nor a merchant", () => {
    // A label alone cannot fire: only a transaction a rule *changed* is tagged.
    const result = validateEdit({
      ...base,
      tokens: ["vensa"],
      categoryId: null,
      labelName: "gp-visits",
    });
    assert.equal(result.ok, false);
  });
});

describe("updateLearnedRule", () => {
  test("rewrites the predicate and outputs, keeping the row's id and position", async () => {
    const graph = graphWith([
      {
        _id: "row_a",
        [MATCH_COL]: buildExpression("DEBIT", ["countdown"]),
        [CATEGORY_COL]: "'other'",
      },
      {
        _id: "row_b",
        [MATCH_COL]: buildExpression("DEBIT", ["3cb-kensingtonh", "vensa"]),
        [CATEGORY_COL]: "'cat_1'",
      },
    ]);

    const validated = validateEdit({
      type: "DEBIT",
      tokens: ["vensa"],
      categoryId: "cat_1",
      merchantId: "mer_1",
      labelName: "gp-visits",
    });
    assert.ok(validated.ok);
    assert.equal(updateLearnedRule(graph, "row_b", validated.edit), true);

    const rules = readLearnedRules(graph);
    assert.equal(rules[1].id, "row_b");
    assert.deepEqual(rules[1].match.tokens, ["vensa"]);
    assert.equal(rules[1].merchantId, "mer_1");
    assert.equal(rules[1].labelName, "gp-visits");

    // And the tidied rule now reaches a payment the reference-bearing one missed.
    assert.deepEqual(await evaluate(graph, { type: "DEBIT", description: "EFTPOS VENSA LTD" }), {
      categoryId: "cat_1",
      merchantId: "mer_1",
      labelName: "gp-visits",
    });
  });

  test("reports an unknown rule id rather than adding one", () => {
    const graph = graphWith([{ _id: "row_a", [MATCH_COL]: VENSA, [CATEGORY_COL]: "'cat_1'" }]);
    const validated = validateEdit({
      type: null,
      tokens: ["vensa"],
      categoryId: "cat_1",
      merchantId: null,
      labelName: null,
    });
    assert.ok(validated.ok);
    assert.equal(updateLearnedRule(graph, "row_gone", validated.edit), false);
    assert.equal(table(graph).rules.length, 1);
  });
});

