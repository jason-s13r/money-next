// No `import "server-only"`: it sits in the same registry as the tools the worker
// loads. Nothing here is reachable from the worker's own conversation — the budget
// inference is offered read tools and `propose_items` only — but the module graph is
// shared, so the constraint is.
import { describeLifespan } from "../../../budget/recurrence";
import { resolveProposedItems, type RawBudgetItem } from "../../../budget/llm";
import type { ProposedItem } from "../../budget/infer";
import { withScopedTx } from "../../db";
import { itemRow } from "../../budget/write";
import { BUDGET_KEY, findBudget, roleOf, windowOf, type FoundBudget } from "./read";
import { asDate, asInt, asText, type Tool, type ToolContext } from "./registry";

// The tools that change a budget.
//
// Only offered to a caller who holds `budget: ["update"]` — see `availableTools` — and
// refused by `runTool` even if somehow called anyway. That is a different grant from
// the one the enrichment tools need (enrich-write.ts, labels.ts, rules.ts): a
// bookkeeper who may recategorise a transaction need not be able to rewrite the
// household's plan, which is why `write` names a scope rather than saying "yes".
//
// They cover what the budget pages cover: a base budget, the layers stacked on it,
// and the items inside either. **A layer is an ordinary budget with a base and a
// window**, which is why there is no separate set of tools for layer items — a layer
// is named the same way a budget is, and `add_budget_items` does not care which it
// was handed. The one rule that is not ordinary is that a layer cannot carry another
// layer, and it is enforced in both places that could break it.
//
// Everything the model says still goes through `resolveProposedItems`, the same gate
// the headless inference uses and the one `tests/budget-llm.test.ts` pins. The model
// only ever sends *names*: a spending area that does not exist drops the row, a
// category it invented degrades to null rather than pointing an item at nothing, and
// a bad frequency drops the row. Nothing reaches a `BudgetItem` without passing it.
//
// No `revalidatePath` here, deliberately. Every page in this app reaches
// `requireWorkspace()` and is therefore dynamically rendered, so there is no cached
// budget page to bust — and `revalidateWorkspacePath` carries `server-only`, which
// this module may not import.

/** The item shape the model fills in, shared by `create_budget` and
 *  `add_budget_items`. Mirrors `propose_items` in the inference, plus `area`: a chat
 *  budget spans every spending area at once, where an inference does one at a time. */
const ITEM_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "What the household would call this commitment, eg 'Weekly shop'.",
    },
    area: {
      type: "string",
      description:
        "The spending area it belongs to, exactly as list_spending_areas named it. Required.",
    },
    direction: { type: "string", enum: ["income", "expense"] },
    amount: {
      type: "number",
      description:
        "The typical amount of a SINGLE occurrence, positive, in the household's display currency.",
    },
    frequency: { type: "string", enum: ["once", "day", "week", "month", "quarter", "year"] },
    interval: {
      type: "integer",
      description: "A whole number of those steps, eg 2 with 'week' for fortnightly.",
    },
    anchorDate: {
      type: "string",
      description: "A representative YYYY-MM-DD the commitment falls on.",
    },
    category: {
      type: "string",
      description: "One of that area's category names, or omitted when none of them fits.",
    },
    merchant: { type: "string", description: "The payee, when there is a clear one." },
    basis: { type: "string", description: "A short note on the evidence for this." },
  },
  required: ["name", "area", "direction", "amount", "frequency", "anchorDate"],
} as const;

/** The dates a budget applies over, shared by everything that can set them. A budget
 *  with no window is the general, always-on one; a layer almost always has one. */
const WINDOW_SCHEMA = {
  startsOn: {
    type: "string",
    description: "YYYY-MM-DD the window opens on. Give both dates or neither.",
  },
  endsOn: {
    type: "string",
    description: "YYYY-MM-DD the window closes on. The day itself is included.",
  },
  repeatsAnnually: {
    type: "boolean",
    description:
      "True for a window that comes round every year, like Christmas — only the day and month then matter. False for a one-off, like a particular holiday.",
  },
} as const;

export const createBudget: Tool = {
  name: "create_budget",
  description:
    "Create a new base budget with a set of items — the household's ongoing plan. Use this once you and the household have agreed what should be in it. For the extra a season or an event needs, create a layer on a base instead. Answers with what was accepted and what was rejected, and why.",
  write: "budget",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "What to call the budget, eg 'Household budget'." },
      items: { type: "array", description: "The budget's items.", items: ITEM_SCHEMA },
      ...WINDOW_SCHEMA,
    },
    required: ["name", "items"],
  },
  async handler(args, ctx) {
    const name = asText(args.name) || "Budget";
    const window = readWindow(args);
    if ("error" in window) return window;

    const { accepted, rejected } = resolveItems(args.items, ctx);
    if (accepted.length === 0) {
      return {
        error: "Nothing could be created — every item was rejected.",
        rejected,
        ...(await areaHint(ctx)),
      };
    }

    const budget = await createBudgetWith(ctx, { name, ...window }, accepted);

    return {
      budget: budget.name,
      created: accepted.length,
      rejected,
      items: accepted.map(summarise),
      note: `Created. It is at /budgets/${budget.id}.`,
    };
  },
};

export const createLayer: Tool = {
  name: "create_layer",
  description:
    "Create a layer on top of an existing base budget: the extra spending a season or an event needs, counted only while the layer's own dates are live. Christmas, a holiday, a course of treatment. Everyday commitments belong in the base, not in a layer.",
  write: "budget",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "What to call the layer, eg 'Christmas'." },
      base: {
        type: "string",
        description: "The base budget to stack it on, by name or id. It must be a base, not a layer.",
      },
      items: {
        type: "array",
        description: "The layer's items — the extra spending, not the base's. May be empty.",
        items: ITEM_SCHEMA,
      },
      ...WINDOW_SCHEMA,
    },
    required: ["name", "base"],
  },
  async handler(args, ctx) {
    const name = asText(args.name) || "Layer";
    const found = await findBudget(ctx, asText(args.base));
    if ("error" in found) return found;
    if (found.budget.baseBudgetId) {
      return {
        error: `"${found.budget.name}" is itself a layer, and a layer cannot carry another. Stack this on ${found.budget.base?.name ?? "its base"} instead.`,
      };
    }

    const window = readWindow(args);
    if ("error" in window) return window;

    // An empty layer is a real thing to make — the household's own "add a layer" form
    // makes one — so no items is fine. Items that were all rejected is not: creating
    // the layer anyway would leave a hollow one behind for the model to trip over on
    // the retry it is about to make.
    const asked = Array.isArray(args.items) && args.items.length > 0;
    const { accepted, rejected } = resolveItems(args.items, ctx);
    if (asked && accepted.length === 0) {
      return {
        error: "The layer was not created — every item was rejected.",
        rejected,
        ...(await areaHint(ctx)),
      };
    }

    const layer = await createBudgetWith(
      ctx,
      { name, baseBudgetId: found.budget.id, ...window },
      accepted,
    );

    return {
      layer: layer.name,
      layerOf: found.budget.name,
      window: describeLifespan(window),
      created: accepted.length,
      rejected,
      items: accepted.map(summarise),
      note: `Created. It is at /budgets/${layer.id}.`,
    };
  },
};

export const updateBudget: Tool = {
  name: "update_budget",
  description:
    "Change a budget or layer itself — not its items. Rename it, change the dates it applies over, or move a layer onto a different base. Only the fields you give are changed.",
  write: "budget",
  parameters: {
    type: "object",
    properties: {
      budget: BUDGET_KEY,
      name: { type: "string", description: "A new name for it." },
      ...WINDOW_SCHEMA,
      alwaysOn: {
        type: "boolean",
        description: "True to clear the dates entirely, so it applies all year round.",
      },
      base: {
        type: "string",
        description:
          "Move this layer onto a different base budget, by name or id. Only a layer can be moved, and only onto a base.",
      },
    },
    required: ["budget"],
  },
  async handler(args, ctx) {
    const found = await findBudget(ctx, asText(args.budget));
    if ("error" in found) return found;
    const budget = found.budget;

    const window = readWindowChange(args, budget);
    if (window && "error" in window) return window;

    let base: FoundBudget | null = null;
    if (asText(args.base)) {
      if (!budget.baseBudgetId) {
        return {
          error: `"${budget.name}" is a base, not a layer. A base cannot be stacked on another budget; only a layer can be moved.`,
        };
      }
      const target = await findBudget(ctx, asText(args.base));
      if ("error" in target) return target;
      if (target.budget.baseBudgetId) {
        return { error: `"${target.budget.name}" is itself a layer, and a layer cannot carry another.` };
      }
      base = target.budget;
    }

    const name = asText(args.name);
    const updated = await ctx.db.budget.update({
      where: { id: budget.id },
      data: {
        ...(name ? { name } : {}),
        ...(window ?? {}),
        ...(base ? { baseBudgetId: base.id } : {}),
      },
      select: {
        id: true,
        name: true,
        baseBudgetId: true,
        base: { select: { name: true } },
        startsOn: true,
        endsOn: true,
        repeatsAnnually: true,
      },
    });

    // A rename changes nothing about where the budget lives: its page is addressed
    // by id, so a link already given out still lands on it under its new name.
    return {
      budget: updated.name,
      id: updated.id,
      ...roleOf(updated),
      ...windowOf(updated, ctx.now),
    };
  },
};

export const deleteBudget: Tool = {
  name: "delete_budget",
  description:
    "Delete a whole budget or layer, with every item in it. This cannot be undone, so confirm with the household first. Deleting a base takes its layers with it, which you must ask for explicitly.",
  write: "budget",
  parameters: {
    type: "object",
    properties: {
      budget: BUDGET_KEY,
      includeLayers: {
        type: "boolean",
        description:
          "True to delete a base's layers along with it. Required when the base has any; it is what the household is agreeing to.",
      },
    },
    required: ["budget"],
  },
  async handler(args, ctx) {
    const found = await findBudget(ctx, asText(args.budget));
    if ("error" in found) return found;
    const budget = found.budget;

    const layers = await ctx.db.budget.findMany({
      where: { baseBudgetId: budget.id },
      select: { name: true, _count: { select: { items: true } } },
    });
    // The database cascades a base's layers away without asking. That is right for the
    // schema and wrong for a conversation, where "delete the old budget" must not
    // silently take three seasonal layers nobody mentioned with it.
    if (layers.length > 0 && args.includeLayers !== true) {
      return {
        error: `"${budget.name}" is a base with ${layers.length} layer(s) on it, which would be deleted too: ${layers
          .map((l) => l.name)
          .join(", ")}. Say so to the household, and call again with includeLayers true if they agree.`,
      };
    }

    const items = await ctx.db.budgetItem.count({ where: { budgetId: budget.id } });
    // deleteMany, not delete: the scoped client filters by workspace, so a miss should
    // answer rather than throw a Prisma not-found.
    const { count } = await ctx.db.budget.deleteMany({ where: { id: budget.id } });
    if (count === 0) return { error: `"${budget.name}" no longer exists.` };

    return {
      deleted: budget.name,
      wasA: budget.baseBudgetId ? "layer" : "base",
      itemsDeleted: items + layers.reduce((sum, l) => sum + l._count.items, 0),
      layersDeleted: layers.map((l) => l.name),
    };
  },
};

export const addBudgetItems: Tool = {
  name: "add_budget_items",
  description:
    "Add items to a budget or layer that already exists. Answers with what was accepted and what was rejected, and why.",
  write: "budget",
  parameters: {
    type: "object",
    properties: {
      budget: BUDGET_KEY,
      items: { type: "array", description: "The items to add.", items: ITEM_SCHEMA },
    },
    required: ["budget", "items"],
  },
  async handler(args, ctx) {
    const found = await findBudget(ctx, asText(args.budget));
    if ("error" in found) return found;

    const { accepted, rejected } = resolveItems(args.items, ctx);
    if (accepted.length === 0) {
      return { error: "Nothing was added — every item was rejected.", rejected, ...(await areaHint(ctx)) };
    }

    await ctx.db.budgetItem.createMany({
      data: accepted.map((item) => chatItemRow(item, found.budget.id, ctx)),
    });

    return {
      budget: found.budget.name,
      ...roleOf(found.budget),
      added: accepted.length,
      rejected,
      items: accepted.map(summarise),
    };
  },
};

export const updateBudgetItem: Tool = {
  name: "update_budget_item",
  description:
    "Change one item of a budget or layer. Give the item id from get_budget and only the fields you are changing; everything else is left alone.",
  write: "budget",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The item id, as get_budget gave it." },
      name: { type: "string" },
      direction: { type: "string", enum: ["income", "expense"] },
      amount: { type: "number", description: "Positive amount of a single occurrence." },
      frequency: { type: "string", enum: ["once", "day", "week", "month", "quarter", "year"] },
      interval: { type: "integer" },
      anchorDate: { type: "string", description: "YYYY-MM-DD." },
      category: {
        type: "string",
        description: "A category of the item's own spending area, or null to clear it.",
      },
      merchant: { type: "string", description: "The payee, or null to clear it." },
      basis: {
        type: "string",
        description:
          "A short note on the evidence for the new figure. Shown to the household beside the item, so say what it rests on.",
      },
    },
    required: ["id"],
  },
  async handler(args, ctx) {
    const id = asText(args.id);
    const existing = await ctx.db.budgetItem.findFirst({
      where: { id },
      select: {
        id: true,
        name: true,
        amount: true,
        frequency: true,
        interval: true,
        anchorDate: true,
        basis: true,
        categoryGroupId: true,
        categoryGroup: { select: { name: true } },
        category: { select: { name: true } },
        merchant: { select: { name: true } },
        budget: { select: { name: true, baseBudgetId: true, base: { select: { name: true } } } },
      },
    });
    if (!existing) {
      return { error: `No budget item with id "${id}". Call get_budget for the current ids.` };
    }

    // Re-resolved as a whole row rather than patched field by field: that way a
    // change goes through exactly the same validation a new item does, and a bad
    // frequency or an invented category is caught the same way instead of being
    // written because it arrived by a different door.
    const wasIncome = existing.amount.toNumber() >= 0;
    const merged: RawBudgetItem = {
      name: "name" in args ? asText(args.name) || existing.name : existing.name,
      group: existing.categoryGroup.name,
      direction:
        asText(args.direction) || (wasIncome ? "income" : "expense"),
      amount:
        args.amount === undefined ? Math.abs(existing.amount.toNumber()) : Number(args.amount),
      frequency: asText(args.frequency) || existing.frequency,
      interval: asInt(args.interval) ?? existing.interval,
      anchorDate:
        asText(args.anchorDate) || existing.anchorDate.toISOString().slice(0, 10),
      category: "category" in args ? asText(args.category) : (existing.category?.name ?? ""),
      merchant: "merchant" in args ? asText(args.merchant) : (existing.merchant?.name ?? ""),
      // The reason for the *new* figure, which is not the reason for the old one. A
      // model that changes an amount and says nothing gets the fallback below rather
      // than keeping a rationale that no longer describes what the row says.
      basis: asText(args.basis) || (args.amount === undefined ? existing.basis : "") || CHAT_BASIS,
    };

    const [resolved] = resolveProposedItems([merged], ctx.catalog, ctx.now);
    if (!resolved) {
      return { error: `That change was rejected: ${whyRejected(merged)}` };
    }

    await ctx.db.budgetItem.update({
      where: { id: existing.id },
      data: {
        name: resolved.name,
        amount: resolved.amount,
        frequency: resolved.frequency,
        interval: resolved.interval,
        anchorDate: resolved.anchorDate,
        categoryId: resolved.categoryId,
        merchantId: resolved.merchantId,
        // A change made in conversation is a change the household asked for.
        inferred: false,
        // …but the figure is still one a model arrived at, so it keeps saying so and
        // keeps its reasons. See `chatItemRow`.
        inferredSource: "ai",
        basis: resolved.basis,
      },
    });

    return {
      budget: existing.budget.name,
      ...roleOf(existing.budget),
      updated: summarise(resolved),
      basis: resolved.basis,
    };
  },
};

export const deleteBudgetItem: Tool = {
  name: "delete_budget_item",
  description: "Remove one item from a budget or layer. Give the item id from get_budget.",
  write: "budget",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The item id, as get_budget gave it." } },
    required: ["id"],
  },
  async handler(args, ctx) {
    const id = asText(args.id);
    // deleteMany, not delete: the scoped client filters by workspace, and a miss
    // should answer with "no such item" rather than throw a Prisma not-found.
    const { count } = await ctx.db.budgetItem.deleteMany({ where: { id } });
    if (count === 0) {
      return { error: `No budget item with id "${id}". Call get_budget for the current ids.` };
    }
    return { deleted: id };
  },
};

// --- Shared. ----------------------------------------------------------------

/** What a row says it rests on when the model changed a figure without saying why.
 *  Something has to be stored: the badge on the household's own screen shows the
 *  reason for a figure, and "no reason given" is itself worth reading. */
const CHAT_BASIS = "Agreed in conversation.";

/** Resolve a batch a row at a time, so each verdict belongs to a known row and the
 *  rejection the model is told about names the item it actually sent. */
function resolveItems(raw: unknown, ctx: ToolContext) {
  const rows: RawBudgetItem[] = Array.isArray(raw) ? (raw as RawBudgetItem[]) : [];
  const accepted: ProposedItem[] = [];
  const rejected: string[] = [];

  for (const row of rows) {
    // The model names the area as `area`; the resolver calls it `group`.
    const item = {
      ...row,
      group: row.group ?? (row as { area?: unknown }).area,
      basis: typeof row.basis === "string" && row.basis.trim() ? row.basis : CHAT_BASIS,
    };
    const [resolved] = resolveProposedItems([item], ctx.catalog, ctx.now);
    if (resolved) accepted.push(resolved);
    else {
      const label = typeof row.name === "string" && row.name.trim() ? row.name : "(unnamed)";
      rejected.push(`${label}: ${whyRejected(item)}`);
    }
  }

  return { accepted, rejected };
}

/**
 * A resolved item as a row, written the way a chat writes one.
 *
 * Two deliberate differences from the seeder's own `itemRow`, and they pull opposite
 * ways on purpose. The row is **not** `inferred`: that flag means "a re-infer may
 * overwrite this", and a figure agreed with the household in conversation must
 * survive the next pass — wiping it would throw away the very thing the chat was
 * for. But it **keeps its provenance**: `inferredSource: ai` and the `basis` the
 * model gave, because the figure is still a model's and the household is entitled to
 * see whose it was and why. That pairing is what the budget page's provenance badge
 * reads (see `app/w/[workspace]/budgets/[budget]/items.tsx`).
 */
function chatItemRow(item: ProposedItem, budgetId: string, ctx: ToolContext) {
  return {
    ...itemRow(item, ctx.db.$workspaceId, budgetId, ctx.currency),
    inferred: false,
  };
}

/** Create a budget or a layer with its items, in one transaction so neither is ever
 *  left half-made. The only difference between the two is `baseBudgetId`. */
async function createBudgetWith(
  ctx: ToolContext,
  budget: {
    name: string;
    baseBudgetId?: string;
    startsOn: Date | null;
    endsOn: Date | null;
    repeatsAnnually: boolean;
  },
  items: ProposedItem[],
): Promise<{ id: string; name: string }> {
  const workspaceId = ctx.db.$workspaceId;

  return withScopedTx(ctx.db, async (tx) => {
    const created = await tx.budget.create({
      data: { workspaceId, origin: "user", ...budget },
      select: { id: true, name: true },
    });
    if (items.length > 0) {
      await tx.budgetItem.createMany({
        data: items.map((item) => chatItemRow(item, created.id, ctx)),
      });
    }
    return { id: created.id, name: created.name };
  });
}

/** The lifespan columns from a create call: both dates or neither, and a window that
 *  runs backwards refused. The mirror of `readLifespan` in the budgets actions, and
 *  refusing for the same reasons — including the one exception, a window that repeats
 *  annually and wraps the New Year (15 Dec – 5 Jan), which is written start-after-end
 *  and is the most obvious seasonal layer there is. */
function readWindow(
  args: Record<string, unknown>,
): { error: string } | { startsOn: Date | null; endsOn: Date | null; repeatsAnnually: boolean } {
  const given = (value: unknown) => typeof value === "string" && value.trim() !== "";
  const startsOn = asDate(args.startsOn);
  const endsOn = asDate(args.endsOn);

  // A date that was sent and did not parse is a mistake to report, not an absence: it
  // would otherwise fall through to "no window at all", which is a different budget.
  for (const [key, value, parsed] of [
    ["startsOn", args.startsOn, startsOn],
    ["endsOn", args.endsOn, endsOn],
  ] as const) {
    if (given(value) && !parsed) {
      return { error: `${key} "${String(value)}" is not a date. Write it as YYYY-MM-DD.` };
    }
  }

  if (!startsOn && !endsOn) return { startsOn: null, endsOn: null, repeatsAnnually: false };
  if (!startsOn || !endsOn) {
    return { error: "A window needs both startsOn and endsOn. Give both, or neither for a budget with no dates." };
  }

  const repeatsAnnually = args.repeatsAnnually === true;
  if (!repeatsAnnually && endsOn < startsOn) {
    return { error: "endsOn is before startsOn. Set repeatsAnnually if you meant a window that wraps the New Year." };
  }
  return { startsOn, endsOn, repeatsAnnually };
}

/**
 * The window change an `update_budget` call is asking for, or null for "leave it".
 *
 * Three ways to ask, and the distinction between them is the whole reason this is not
 * `readWindow`: clearing the dates, replacing them, or keeping the dates and only
 * changing whether they come round again. The last is why the budget's current
 * window is needed — `repeatsAnnually` alone means nothing without dates to repeat.
 */
function readWindowChange(
  args: Record<string, unknown>,
  budget: { startsOn: Date | null; endsOn: Date | null; repeatsAnnually: boolean },
): null | { error: string } | { startsOn: Date | null; endsOn: Date | null; repeatsAnnually: boolean } {
  if (args.alwaysOn === true) return { startsOn: null, endsOn: null, repeatsAnnually: false };

  const dated = ["startsOn", "endsOn"].some(
    (key) => typeof args[key] === "string" && String(args[key]).trim() !== "",
  );
  if (dated) return readWindow(args);

  if (typeof args.repeatsAnnually === "boolean") {
    if (!budget.startsOn || !budget.endsOn) {
      return { error: "That budget has no dates to repeat. Give startsOn and endsOn as well." };
    }
    return {
      startsOn: budget.startsOn,
      endsOn: budget.endsOn,
      repeatsAnnually: args.repeatsAnnually,
    };
  }

  return null;
}

/** Why a row did not survive `resolveProposedItems`, in the words the model needs to
 *  fix it. Mirrors that function's checks in order. */
export function whyRejected(row: RawBudgetItem): string {
  if (typeof row.name !== "string" || !row.name.trim()) return "no name";
  const magnitude = Math.abs(Number(row.amount));
  if (!Number.isFinite(magnitude) || magnitude === 0) return "amount must be a non-zero number";
  if (typeof row.frequency !== "string") return "frequency is required";
  if (!["once", "day", "week", "month", "quarter", "year"].includes(row.frequency)) {
    return `frequency "${row.frequency}" is not one of once|day|week|month|quarter|year`;
  }
  if (typeof row.group !== "string" || !row.group.trim()) return "no spending area";
  return `spending area "${row.group}" is not one of the household's`;
}

/** The real area names, handed back when a batch failed, since naming an area that
 *  does not exist is the commonest way for one to. */
async function areaHint(ctx: ToolContext) {
  const { areas } = await ctx.history();
  return { allowedAreas: [...areas.values()].map((a) => a.name) };
}

const summarise = (item: {
  name: string;
  amount: number;
  cadence: string;
  groupName: string;
}) => ({
  name: item.name,
  amount: item.amount,
  cadence: item.cadence,
  area: item.groupName,
});

export const WRITE_TOOLS: Tool[] = [
  createBudget,
  createLayer,
  updateBudget,
  deleteBudget,
  addBudgetItems,
  updateBudgetItem,
  deleteBudgetItem,
];
