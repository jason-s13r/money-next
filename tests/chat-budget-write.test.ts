/**
 * The chat's write tools: budgets, layers, and the items in either.
 *
 *   pnpm test
 *
 * These are the only tools that change the household's plan, and they are driven by
 * a small local model that will get the call wrong. So what is pinned here is not
 * that the happy path writes a row — it is everything the model can be wrong about,
 * because each of those is a way for a conversation to quietly do the wrong thing to
 * somebody's money.
 *
 * **A layer is an ordinary budget with a base and a window**, which is why there is
 * no separate set of tools for layer items. The rule that is *not* ordinary is that
 * a layer cannot carry another layer, and it is enforced in both places that could
 * break it: creating one, and moving one.
 *
 * **A figure a model wrote keeps saying so.** `inferredSource: ai` and a `basis` are
 * what put the "AI" badge and its popover on the budget page, and a chat-written row
 * is not `inferred` — those pull opposite ways on purpose and the pairing is easy to
 * lose in a refactor. See `chatItemRow`.
 *
 * **A destructive call is refused rather than guessed at.** Deleting a base cascades
 * its layers away in the database; here that has to be asked for.
 *
 * Seeds its own `ws_test_chatwrite` workspace and category group, and drops both.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { catalogDb, scopedDb } from "../lib/server/db";
import {
  addBudgetItems,
  createBudget,
  createLayer,
  deleteBudget,
  deleteBudgetItem,
  updateBudget,
  updateBudgetItem,
} from "../lib/server/chat/tools/budget-write";
import { getBudget, listBudgets } from "../lib/server/chat/tools/read";
import type { Tool, ToolContext } from "../lib/server/chat/tools/registry";

const WS = "ws_test_chatwrite";
/** A shared-catalog group, so the items written here have a real bucket to sit in —
 *  `BudgetItem.categoryGroupId` is `Restrict`, and the resolver drops any row whose
 *  area it cannot find. */
const GROUP = "group_test_chatwrite";
const NOW = new Date("2026-07-25T00:00:00Z");

const db = scopedDb(WS);

const ctx: ToolContext = {
  db,
  now: NOW,
  currency: "NZD",
  catalog: {
    groups: new Map([["food", { id: GROUP, name: "Food" }]]),
    categories: new Map(),
    merchants: new Map(),
  },
  // Only reached when a whole batch was rejected, to hand back the real area names.
  history: async () => ({
    areas: new Map(),
    byName: new Map(),
    count: 0,
    monthsOfHistory: 18,
    currency: "NZD",
  }),
  fx: async () => ({ currency: "NZD", toDisplay: (amount: number) => amount }),
  can: { budget: true, enrichment: true },
  actorUserId: null,
};

type Result = Record<string, unknown>;

/** Run a tool the way the registry runs it, minus the error trapping — a handler that
 *  throws in here should fail the test rather than become a polite value. */
const call = async (tool: Tool, args: Record<string, unknown>): Promise<Result> =>
  (await tool.handler(args, ctx, { toolCallId: "call_1" })) as Result;

const shop = (over: Record<string, unknown> = {}) => ({
  name: "Weekly shop",
  area: "Food",
  direction: "expense",
  amount: 200,
  frequency: "week",
  anchorDate: "2026-07-03",
  basis: "18 months of Friday shops",
  ...over,
});

/** A base to hang layers off, made directly rather than through a tool so a test of
 *  layers is not also a test of `create_budget`. */
async function seedBase(name: string) {
  return db.budget.create({
    data: { workspaceId: WS, name, origin: "user" },
    select: { id: true, name: true },
  });
}

const budgetNamed = (name: string) =>
  db.budget.findFirstOrThrow({
    where: { name },
    select: {
      id: true,
      startsOn: true,
      endsOn: true,
      repeatsAnnually: true,
      baseBudgetId: true,
      items: {
        select: {
          id: true,
          name: true,
          amount: true,
          currency: true,
          frequency: true,
          interval: true,
          anchorDate: true,
          inferred: true,
          inferredSource: true,
          basis: true,
          categoryGroupId: true,
        },
      },
    },
  });

before(async () => {
  await catalogDb.workspace.deleteMany({ where: { id: WS } });
  await catalogDb.workspace.create({ data: { id: WS, name: "Test chat write", slug: "test-chatwrite" } });
  await catalogDb.categoryGroup.upsert({
    where: { id: GROUP },
    create: { id: GROUP, name: "Food" },
    update: {},
  });
});

beforeEach(async () => {
  // Layers first would be tidier, but a base takes its layers with it.
  await db.budget.deleteMany({});
});

after(async () => {
  await catalogDb.workspace.deleteMany({ where: { id: WS } });
  await catalogDb.categoryGroup.deleteMany({ where: { id: GROUP } });
  await catalogDb.$disconnect();
});

describe("create_budget", () => {
  test("writes the items, and they keep saying a model wrote them", async () => {
    const result = await call(createBudget, { name: "Household", items: [shop()] });
    assert.equal(result.created, 1);

    const budget = await budgetNamed("Household");
    assert.equal(budget.baseBudgetId, null, "create_budget makes a base");
    const [item] = budget.items;
    assert.equal(item.name, "Weekly shop");
    assert.equal(Number(item.amount), -200, "an expense is stored negative, like a transaction");
    assert.equal(item.currency, "NZD");

    // The three columns behind the budget page's provenance badge. `inferred: false`
    // *and* a source is the combination that only a chat write produces: a model's
    // figure that a re-infer must not overwrite, because it was agreed out loud.
    assert.equal(item.inferredSource, "ai");
    assert.equal(item.basis, "18 months of Friday shops");
    assert.equal(item.inferred, false);
  });

  test("a figure the model gave no reason for still says something", async () => {
    // The badge shows a reason; "none given" is itself worth reading, and a null here
    // would render as a badge with nothing behind it.
    await call(createBudget, { name: "Household", items: [shop({ basis: undefined })] });
    const budget = await budgetNamed("Household");
    assert.match(String(budget.items[0].basis), /Agreed in conversation/);
  });

  test("nothing is created when every item was rejected", async () => {
    const result = await call(createBudget, {
      name: "Household",
      items: [shop({ area: "Groceries" })],
    });
    assert.match(String(result.error), /every item was rejected/);
    assert.match(String((result.rejected as string[])[0]), /spending area "Groceries"/);
    assert.deepEqual(result.allowedAreas, [], "the real areas, so the retry can be right");
    assert.equal(await db.budget.count({}), 0, "no empty budget left behind");
  });

  test("dates are optional, and both ends are needed when there are any", async () => {
    const half = await call(createBudget, {
      name: "Household",
      items: [shop()],
      startsOn: "2026-12-01",
    });
    assert.match(String(half.error), /both startsOn and endsOn/);

    const bad = await call(createBudget, {
      name: "Household",
      items: [shop()],
      startsOn: "1 December",
      endsOn: "2026-12-25",
    });
    assert.match(String(bad.error), /is not a date/);
    assert.equal(await db.budget.count({}), 0);
  });
});

describe("create_layer", () => {
  test("stacks on a base, with its own window", async () => {
    await seedBase("Household");
    const result = await call(createLayer, {
      name: "Christmas",
      base: "Household",
      items: [shop({ name: "Presents", frequency: "once", anchorDate: "2026-12-20", amount: 600 })],
      startsOn: "2026-12-01",
      endsOn: "2026-12-25",
      repeatsAnnually: true,
    });
    assert.equal(result.layerOf, "Household");

    const layer = await budgetNamed("Christmas");
    const base = await budgetNamed("Household");
    assert.equal(layer.baseBudgetId, base.id);
    assert.equal(layer.repeatsAnnually, true);
    assert.equal(layer.startsOn?.toISOString().slice(0, 10), "2026-12-01");
    assert.equal(layer.items.length, 1);
  });

  test("a window that wraps the New Year is allowed when it repeats", async () => {
    // 15 Dec – 5 Jan is written start-after-end and is the most obvious seasonal
    // layer there is; refusing it would forbid the case the feature exists for.
    await seedBase("Household");
    const wrapping = await call(createLayer, {
      name: "Christmas",
      base: "Household",
      startsOn: "2026-12-15",
      endsOn: "2027-01-05",
      repeatsAnnually: true,
    });
    assert.equal(wrapping.layer, "Christmas");

    const backwards = await call(createLayer, {
      name: "Holiday",
      base: "Household",
      startsOn: "2026-12-15",
      endsOn: "2026-12-05",
    });
    assert.match(String(backwards.error), /endsOn is before startsOn/);
  });

  test("a layer cannot carry another layer", async () => {
    const base = await seedBase("Household");
    await db.budget.create({
      data: { workspaceId: WS, name: "Christmas", baseBudgetId: base.id },
    });

    const result = await call(createLayer, { name: "Presents", base: "Christmas" });
    assert.match(String(result.error), /itself a layer/);
    assert.match(String(result.error), /Household/, "and says where it should go instead");
    assert.equal(await db.budget.count({ where: { name: "Presents" } }), 0);
  });

  test("an empty layer is a real thing to make; a layer of rejected items is not", async () => {
    await seedBase("Household");

    await call(createLayer, { name: "Holiday", base: "Household" });
    assert.equal((await budgetNamed("Holiday")).items.length, 0);

    const rejected = await call(createLayer, {
      name: "Christmas",
      base: "Household",
      items: [shop({ area: "Presents" })],
    });
    assert.match(String(rejected.error), /every item was rejected/);
    assert.equal(
      await db.budget.count({ where: { name: "Christmas" } }),
      0,
      "a hollow layer would be left for the model to trip over on its retry",
    );
  });

  test("an unknown base is answered with the ones that exist", async () => {
    await seedBase("Household");
    const result = await call(createLayer, { name: "Christmas", base: "Housold" });
    assert.match(String(result.error), /No budget called "Housold"/);
    assert.match(String((result.budgets as string[])[0]), /Household \(base, id \w+\)/);
  });
});

describe("update_budget", () => {
  test("renames without moving the budget's address", async () => {
    const before = await seedBase("Household");
    const result = await call(updateBudget, { budget: "Household", name: "Everyday" });
    assert.equal(result.budget, "Everyday");
    // The id is the address, and a rename is not a move: a link already given out
    // still lands on it. That is the whole reason a budget has no slug.
    assert.equal((await budgetNamed("Everyday")).id, before.id);
  });

  test("sets a window, and clears one", async () => {
    await seedBase("Household");
    await call(updateBudget, { budget: "Household", startsOn: "2026-08-01", endsOn: "2026-08-31" });
    assert.equal((await budgetNamed("Household")).endsOn?.toISOString().slice(0, 10), "2026-08-31");

    const cleared = await call(updateBudget, { budget: "Household", alwaysOn: true });
    assert.equal(cleared.window, "Always on");
    const after = await budgetNamed("Household");
    assert.equal(after.startsOn, null);
    assert.equal(after.repeatsAnnually, false);
  });

  test("making an existing window repeat keeps its dates", async () => {
    await db.budget.create({
      data: {
        workspaceId: WS,
        name: "Christmas",
        startsOn: new Date("2026-12-01T00:00:00Z"),
        endsOn: new Date("2026-12-25T00:00:00Z"),
      },
    });

    const result = await call(updateBudget, { budget: "Christmas", repeatsAnnually: true });
    assert.equal(result.startsOn, "2026-12-01", "the dates were not asked about, so they stay");
    assert.equal(result.repeatsAnnually, true);
  });

  test("a budget with no dates cannot be made to repeat them", async () => {
    await seedBase("Household");
    const result = await call(updateBudget, { budget: "Household", repeatsAnnually: true });
    assert.match(String(result.error), /no dates to repeat/);
  });

  test("moves a layer between bases, and refuses everything else", async () => {
    const base = await seedBase("This year");
    await seedBase("Next year");
    await db.budget.create({
      data: { workspaceId: WS, name: "Christmas", baseBudgetId: base.id },
    });

    const moved = await call(updateBudget, { budget: "Christmas", base: "Next year" });
    assert.equal(moved.layerOf, "Next year");
    assert.equal((await budgetNamed("Christmas")).baseBudgetId, (await budgetNamed("Next year")).id);

    const promoted = await call(updateBudget, { budget: "This year", base: "Next year" });
    assert.match(String(promoted.error), /is a base, not a layer/);

    const stacked = await call(updateBudget, { budget: "Next year", base: "Christmas" });
    assert.match(String(stacked.error), /is a base, not a layer/);
  });
});

describe("delete_budget", () => {
  test("a base with layers is refused until the cascade is asked for", async () => {
    const base = await seedBase("Household");
    await db.budget.create({
      data: { workspaceId: WS, name: "Christmas", baseBudgetId: base.id },
    });

    const refused = await call(deleteBudget, { budget: "Household" });
    assert.match(String(refused.error), /Christmas/, "names what would go with it");
    assert.match(String(refused.error), /includeLayers/);
    assert.equal(await db.budget.count({}), 2, "nothing was deleted while it was being asked");

    const done = await call(deleteBudget, { budget: "Household", includeLayers: true });
    assert.deepEqual(done.layersDeleted, ["Christmas"]);
    assert.equal(await db.budget.count({}), 0);
  });

  test("a layer goes on its own, and its items with it", async () => {
    const base = await seedBase("Household");
    await call(createLayer, { name: "Christmas", base: "Household", items: [shop()] });

    const result = await call(deleteBudget, { budget: "Christmas" });
    assert.equal(result.wasA, "layer");
    assert.equal(result.itemsDeleted, 1);
    assert.equal(await db.budget.count({ where: { id: base.id } }), 1, "the base is untouched");
    assert.equal(await db.budgetItem.count({}), 0);
  });
});

describe("items, in a layer as in a budget", () => {
  test("added by naming the layer, and they carry the same provenance", async () => {
    await seedBase("Household");
    await call(createLayer, { name: "Christmas", base: "Household" });

    const result = await call(addBudgetItems, {
      budget: "Christmas",
      items: [shop({ name: "Presents", basis: "Last two Decembers" })],
    });
    assert.equal(result.added, 1);
    assert.equal(result.role, "layer", "so the model can see where its item landed");

    const [item] = (await budgetNamed("Christmas")).items;
    assert.equal(item.inferredSource, "ai");
    assert.equal(item.basis, "Last two Decembers");
    assert.equal(item.inferred, false);
  });

  test("a change is re-validated whole, and re-states why", async () => {
    await call(createBudget, { name: "Household", items: [shop()] });
    const [before] = (await budgetNamed("Household")).items;

    const bad = await call(updateBudgetItem, { id: before.id, frequency: "fortnight" });
    assert.match(String(bad.error), /not one of once\|day\|week\|month\|quarter\|year/);

    const ok = await call(updateBudgetItem, {
      id: before.id,
      amount: 240,
      basis: "The last three months averaged $240",
    });
    assert.equal((ok.updated as Result).amount, -240);

    const [after] = (await budgetNamed("Household")).items;
    assert.equal(Number(after.amount), -240);
    assert.equal(after.frequency, "week", "the fields not given were left alone");
    assert.equal(after.inferredSource, "ai", "still a model's figure, and still says so");
    assert.equal(after.basis, "The last three months averaged $240");
  });

  test("a new amount with no reason does not keep the old one's", async () => {
    await call(createBudget, { name: "Household", items: [shop()] });
    const [item] = (await budgetNamed("Household")).items;

    await call(updateBudgetItem, { id: item.id, amount: 300 });
    const [changed] = (await budgetNamed("Household")).items;
    assert.match(String(changed.basis), /Agreed in conversation/);
  });

  test("an item id that does not exist is said so, not thrown", async () => {
    const missing = await call(updateBudgetItem, { id: "nope", amount: 10 });
    assert.match(String(missing.error), /No budget item with id "nope"/);
    assert.match(String((await call(deleteBudgetItem, { id: "nope" })).error), /No budget item/);
  });

  test("deleted by id", async () => {
    await call(createBudget, { name: "Household", items: [shop()] });
    const [item] = (await budgetNamed("Household")).items;
    assert.deepEqual(await call(deleteBudgetItem, { id: item.id }), { deleted: item.id });
    assert.equal(await db.budgetItem.count({}), 0);
  });
});

describe("naming one budget of several", () => {
  test("two budgets with one name are a question, not a coin toss", async () => {
    // Layers make this ordinary: "Christmas" on this year's base and "Christmas" on
    // next year's are the same word for two budgets, and picking either silently
    // would edit the wrong one.
    const a = await seedBase("This year");
    const b = await seedBase("Next year");
    await db.budget.create({
      data: { workspaceId: WS, name: "Christmas", baseBudgetId: a.id },
    });
    await db.budget.create({
      data: { workspaceId: WS, name: "Christmas", baseBudgetId: b.id },
    });

    const theirs = await db.budget.findFirstOrThrow({
      where: { name: "Christmas", baseBudgetId: b.id },
      select: { id: true },
    });

    const ambiguous = await call(getBudget, { budget: "Christmas" });
    assert.match(String(ambiguous.error), /More than one budget is called "Christmas"/);
    assert.match(String(ambiguous.error), new RegExp(theirs.id), "and the ids that tell them apart");

    const named = await call(getBudget, { budget: theirs.id });
    assert.equal(named.layerOf, "Next year");
  });

  test("the list says which are layers and which are live", async () => {
    const base = await seedBase("Household");
    await db.budget.create({
      data: {
        workspaceId: WS,
        name: "Christmas",
        baseBudgetId: base.id,
        startsOn: new Date("2026-12-01T00:00:00Z"),
        endsOn: new Date("2026-12-25T00:00:00Z"),
        repeatsAnnually: true,
      },
    });

    const { budgets } = (await call(listBudgets, {})) as { budgets: Result[] };
    const christmas = budgets.find((b) => b.budget === "Christmas")!;
    assert.equal(christmas.role, "layer");
    assert.equal(christmas.layerOf, "Household");
    assert.equal(christmas.window, "1 Dec – 25 Dec, yearly");
    // NOW is July, so the Christmas layer is not being counted today.
    assert.equal(christmas.activeNow, false);
    assert.equal(budgets.find((b) => b.budget === "Household")!.role, "base");
  });
});
