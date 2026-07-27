/**
 * The pure half of LLM budget inference: parsing a model's reply and resolving it
 * to real ids.
 *
 *   pnpm test
 *
 * The model is never trusted, so this is where that distrust is enforced: a group
 * that does not exist drops the row, a bad frequency drops it, a category it made
 * up degrades to null rather than pointing a budget item at nothing. None of these
 * throw at runtime — a mis-mapped budget item is just quietly wrong money — so they
 * are pinned here. No network and no database: `resolveProposedItems` takes a
 * `Catalog` built by hand, exactly the shape the server half builds from the DB.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  catKey,
  dedupeProposedItems,
  parseModelContent,
  resolveProposedItems,
  type Catalog,
} from "../lib/budget/llm";

// A synthetic catalog, deliberately small and generic. Group and category names
// are the NZFCC-style ones the real catalog carries; ids are stand-ins.
const catalog: Catalog = {
  groups: new Map([
    ["food", { id: "group_food", name: "Food" }],
    ["utilities", { id: "group_utilities", name: "Utilities" }],
  ]),
  categories: new Map([
    [catKey("group_food", "Supermarkets"), { id: "cat_supermarkets", name: "Supermarkets" }],
  ]),
  merchants: new Map([["corner grocer", { id: "merch_grocer", name: "Corner Grocer" }]]),
};

const NOW = new Date("2026-07-25T00:00:00Z");

describe("parseModelContent unwraps whatever the model wrapped its items in", () => {
  test("a bare array", () => {
    assert.equal(parseModelContent(`[{"name":"a"}]`).length, 1);
  });

  test("the documented { items: [...] } envelope", () => {
    assert.equal(parseModelContent(`{"items":[{"name":"a"},{"name":"b"}]}`).length, 2);
  });

  test("a { budget: [...] } the model chose instead", () => {
    assert.equal(parseModelContent(`{"budget":[{"name":"a"}]}`).length, 1);
  });

  test("garbage is empty, not an exception", () => {
    assert.deepEqual(parseModelContent("not json at all"), []);
    assert.deepEqual(parseModelContent(`{"nope":true}`), []);
    assert.deepEqual(parseModelContent("42"), []);
  });
});

describe("resolveProposedItems maps names to ids and drops what will not", () => {
  test("a full row resolves group, category and merchant", () => {
    const [item] = resolveProposedItems(
      [
        {
          name: "Weekly shop",
          direction: "expense",
          amount: 500,
          frequency: "week",
          interval: 1,
          anchorDate: "2026-07-18",
          group: "Food",
          category: "Supermarkets",
          merchant: "Corner Grocer",
          basis: "every week",
        },
      ],
      catalog,
      NOW,
    );

    assert.equal(item.groupId, "group_food");
    assert.equal(item.categoryId, "cat_supermarkets");
    assert.equal(item.merchantId, "merch_grocer");
    // Expense is stored negative, like Transaction.amount.
    assert.equal(item.amount, -500);
    assert.equal(item.frequency, "week");
    assert.equal(item.anchorDate.toISOString().slice(0, 10), "2026-07-18");
    assert.equal(item.kind, "recurring");
  });

  test("income keeps a positive sign", () => {
    const [item] = resolveProposedItems(
      [{ name: "Pay", direction: "income", amount: 3000, frequency: "month", group: "Food" }],
      catalog,
      NOW,
    );
    assert.equal(item.amount, 3000);
  });

  test("group names are matched case-insensitively", () => {
    const [item] = resolveProposedItems(
      [{ name: "x", direction: "expense", amount: 10, frequency: "month", group: "FOOD" }],
      catalog,
      NOW,
    );
    assert.equal(item.groupId, "group_food");
  });

  test("a group that does not exist drops the whole row", () => {
    const items = resolveProposedItems(
      [{ name: "x", direction: "expense", amount: 10, frequency: "month", group: "Invented" }],
      catalog,
      NOW,
    );
    assert.equal(items.length, 0);
  });

  test("a made-up category degrades to null but keeps the row", () => {
    const [item] = resolveProposedItems(
      [
        {
          name: "x",
          direction: "expense",
          amount: 10,
          frequency: "month",
          group: "Food",
          category: "Truffles",
        },
      ],
      catalog,
      NOW,
    );
    assert.equal(item.groupId, "group_food");
    assert.equal(item.categoryId, null);
    assert.equal(item.categoryName, null);
  });

  test("a category under the wrong group does not resolve", () => {
    // "Supermarkets" exists, but under Food, not Utilities.
    const [item] = resolveProposedItems(
      [
        {
          name: "x",
          direction: "expense",
          amount: 10,
          frequency: "month",
          group: "Utilities",
          category: "Supermarkets",
        },
      ],
      catalog,
      NOW,
    );
    assert.equal(item.categoryId, null);
  });

  test("an unknown merchant degrades to null", () => {
    const [item] = resolveProposedItems(
      [
        {
          name: "x",
          direction: "expense",
          amount: 10,
          frequency: "month",
          group: "Food",
          merchant: "Someone Else",
        },
      ],
      catalog,
      NOW,
    );
    assert.equal(item.merchantId, null);
  });

  test("a bad frequency drops the row", () => {
    const items = resolveProposedItems(
      [{ name: "x", direction: "expense", amount: 10, frequency: "fortnight", group: "Food" }],
      catalog,
      NOW,
    );
    assert.equal(items.length, 0);
  });

  test("a zero or non-numeric amount drops the row", () => {
    const items = resolveProposedItems(
      [
        { name: "a", direction: "expense", amount: 0, frequency: "month", group: "Food" },
        { name: "b", direction: "expense", amount: "lots", frequency: "month", group: "Food" },
      ],
      catalog,
      NOW,
    );
    assert.equal(items.length, 0);
  });

  test("a nameless row drops", () => {
    const items = resolveProposedItems(
      [{ name: "  ", direction: "expense", amount: 10, frequency: "month", group: "Food" }],
      catalog,
      NOW,
    );
    assert.equal(items.length, 0);
  });

  test("an out-of-range interval falls back to 1, not the whole row", () => {
    const [item] = resolveProposedItems(
      [{ name: "x", direction: "expense", amount: 10, frequency: "week", interval: 999, group: "Food" }],
      catalog,
      NOW,
    );
    assert.equal(item.interval, 1);
  });

  test("a missing or unparseable anchorDate falls back to the first of this month", () => {
    const [item] = resolveProposedItems(
      [{ name: "x", direction: "expense", amount: 10, frequency: "month", group: "Food" }],
      catalog,
      NOW,
    );
    assert.equal(item.anchorDate.toISOString().slice(0, 10), "2026-07-01");
  });

  test("keys are unique even when two rows share group, category and merchant", () => {
    const items = resolveProposedItems(
      [
        { name: "a", direction: "expense", amount: 10, frequency: "month", group: "Food" },
        { name: "b", direction: "expense", amount: 20, frequency: "month", group: "Food" },
      ],
      catalog,
      NOW,
    );
    assert.equal(items.length, 2);
    assert.notEqual(items[0].key, items[1].key);
  });
});

describe("dedupeProposedItems collapses genuine repeats, keeping the largest", () => {
  // Everything the model returned in one window, resolved — the shape dedupe runs on.
  const resolve = (raw: Parameters<typeof resolveProposedItems>[0]) =>
    resolveProposedItems(raw, catalog, NOW);

  test("the same payee under the same name is one commitment", () => {
    const items = dedupeProposedItems(
      resolve([
        { name: "Weekly shop", direction: "expense", amount: 200, frequency: "week", group: "Food", merchant: "Corner Grocer" },
        { name: "weekly shop", direction: "expense", amount: 350, frequency: "week", group: "Food", merchant: "Corner Grocer" },
      ]),
    );
    assert.equal(items.length, 1);
    // The larger magnitude survives; amounts are never summed.
    assert.equal(items[0].amount, -350);
  });

  test("one payee with distinctly named commitments keeps them all (the Skinny case)", () => {
    // Broadband and two mobile lines, all "Corner Grocer" here standing in for one
    // telco: same payee, same group, but three real commitments named apart.
    const items = dedupeProposedItems(
      resolve([
        { name: "Skinny broadband", direction: "expense", amount: 100, frequency: "month", group: "Food", merchant: "Corner Grocer" },
        { name: "Skinny mobile ·8308", direction: "expense", amount: 40, frequency: "month", group: "Food", merchant: "Corner Grocer" },
        { name: "Skinny mobile ·1445", direction: "expense", amount: 40, frequency: "month", group: "Food", merchant: "Corner Grocer" },
      ]),
    );
    assert.equal(items.length, 3);
  });

  test("with no payee, identical names collapse", () => {
    const items = dedupeProposedItems(
      resolve([
        { name: "School fees", direction: "expense", amount: 100, frequency: "month", group: "Food" },
        { name: "school fees", direction: "expense", amount: 120, frequency: "month", group: "Food" },
      ]),
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].amount, -120);
  });

  test("with no payee, different names are both kept", () => {
    const items = dedupeProposedItems(
      resolve([
        { name: "School fees", direction: "expense", amount: 100, frequency: "month", group: "Food" },
        { name: "Music lessons", direction: "expense", amount: 80, frequency: "month", group: "Food" },
      ]),
    );
    assert.equal(items.length, 2);
  });

  test("the same payee in different groups is not merged", () => {
    const items = dedupeProposedItems(
      resolve([
        { name: "a", direction: "expense", amount: 50, frequency: "month", group: "Food", merchant: "Corner Grocer" },
        { name: "b", direction: "expense", amount: 60, frequency: "month", group: "Utilities", merchant: "Corner Grocer" },
      ]),
    );
    assert.equal(items.length, 2);
  });
});
