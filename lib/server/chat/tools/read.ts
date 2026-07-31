// No `import "server-only"`: shared with the worker's budget inference.
import {
  activeOn,
  describeLifespan,
  describeRecurrence,
  isFrequency,
} from "../../../budget/recurrence";
import { money, moneyOrNull } from "../../money";
import { MAX_TOOL_ROWS } from "../client";
import type { Area } from "./history";
import { getPeriodBreakdown } from "./metrics";
import {
  asDay,
  asInt,
  asText,
  distinct,
  topBy,
  type Tool,
  type ToolContext,
} from "./registry";

// The tools that only look.
//
// `list_spending_areas` and `get_transactions` are the pair the budget inference has
// always had, lifted out of lib/server/budget/llm.ts unchanged in behaviour: the map
// first, then paged reads of whatever the model decides to look at. The rest exist for
// the chat, where "what am I already budgeting for?" is a question the inference never
// had to answer because it was always building from nothing.
//
// Every one of these returns plain JSON-able data. Errors come back as values with the
// information needed to retry — an unknown area answers with the real list of areas —
// because a model that can see its mistake fixes it on the next turn.

/** How every tool that works on one budget asks for it — here, and reused by the write
 *  tools, because a model that learns the rule on `get_budget` should not have to
 *  relearn it on `add_budget_items`. See `findBudget` for why the id is offered too. */
export const BUDGET_KEY = {
  type: "string",
  description:
    "The budget or layer, by name as list_budgets gave it — or by its id, which is the only way to name one of two budgets that share a name.",
} as const;

export const listSpendingAreas: Tool = {
  name: "list_spending_areas",
  description:
    "List the household's spending areas (category groups): how many transactions each holds, over what dates, its categories and its biggest payees. Call this first when you need to know what the household spends on.",
  parameters: { type: "object", properties: {}, required: [] },
  async handler(_args, ctx) {
    const { areas, currency, monthsOfHistory } = await ctx.history();
    return {
      currency,
      monthsOfHistory,
      areas: [...areas.values()]
        .sort((a, b) => b.txns.length - a.txns.length)
        .map((area) => ({
          area: area.name,
          transactions: area.txns.length,
          // Rows are newest first, so the span is the last row to the first.
          from: area.txns[area.txns.length - 1]?.date ?? null,
          to: area.txns[0]?.date ?? null,
          total: round2(area.txns.reduce((sum, t) => sum + t.amount, 0)),
          categories: distinct(area.txns.map((t) => t.category)),
          // The payees worth naming, not every one: a long tail of one-off shops says
          // nothing here, and the model can search for anything this leaves out.
          topMerchants: topBy(area.txns, (t) => t.merchant, 15),
        })),
    };
  },
};

export const getTransactions: Tool = {
  name: "get_transactions",
  description:
    `Read one spending area's transactions, newest first. Returns at most ${MAX_TOOL_ROWS} rows; ` +
    "when the result says more:true there are further rows, which you get by calling again with offset advanced by the number returned.",
  parameters: {
    type: "object",
    properties: {
      area: {
        type: "string",
        description: "The spending area name, exactly as list_spending_areas gave it.",
      },
      category: {
        type: "string",
        description: "Optional. Only transactions in this category of the area.",
      },
      search: {
        type: "string",
        description:
          "Optional. Only transactions whose payee, description, reference, particulars or code contain this text.",
      },
      from: { type: "string", description: "Optional YYYY-MM-DD lower bound on the date." },
      to: { type: "string", description: "Optional YYYY-MM-DD upper bound on the date." },
      offset: { type: "integer", description: "Rows to skip. Default 0." },
      limit: {
        type: "integer",
        description: `Rows to return. Default and maximum ${MAX_TOOL_ROWS}.`,
      },
    },
    required: ["area"],
  },
  async handler(args, ctx) {
    const { result } = await readTransactions(args, ctx);
    return result;
  },
};

/**
 * `get_transactions`, with the area it resolved to handed back alongside the result.
 *
 * The budget inference needs to know *which* area a read served, so it can drop those
 * rows from the conversation once that area has been proposed for. Nothing else cares,
 * so the tool itself returns only the result and this is the seam.
 */
export async function readTransactions(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ result: unknown; area: Area | null }> {
  const { byName } = await ctx.history();
  const name = asText(args.area);
  const area = byName.get(name.toLowerCase());
  if (!area) {
    return {
      area: null,
      result: {
        error: `No spending area called "${name}".`,
        areas: [...byName.values()].map((a) => a.name),
      },
    };
  }

  const category = asText(args.category).toLowerCase();
  const search = asText(args.search).toLowerCase();
  const from = asDay(args.from);
  const to = asDay(args.to);

  const matched = area.txns.filter((tx) => {
    if (category && (tx.category ?? "").toLowerCase() !== category) return false;
    if (from && tx.date < from) return false;
    if (to && tx.date > to) return false;
    if (search) {
      const haystack = [tx.merchant, tx.description, tx.reference, tx.particulars, tx.code]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const offset = Math.max(0, asInt(args.offset) ?? 0);
  const limit = Math.min(MAX_TOOL_ROWS, Math.max(1, asInt(args.limit) ?? MAX_TOOL_ROWS));
  const page = matched.slice(offset, offset + limit);

  return {
    area,
    result: {
      area: area.name,
      matched: matched.length,
      offset,
      returned: page.length,
      more: offset + page.length < matched.length,
      transactions: page,
    },
  };
}

export const listBudgets: Tool = {
  name: "list_budgets",
  description:
    "List the household's existing budgets and layers: name, whether it is a base or a layer of one, the dates it applies over, how many items it has, and its monthly planned income and spending.",
  parameters: { type: "object", properties: {}, required: [] },
  async handler(_args, ctx) {
    const budgets = await ctx.db.budget.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        origin: true,
        startsOn: true,
        endsOn: true,
        repeatsAnnually: true,
        baseBudgetId: true,
        base: { select: { name: true } },
        items: { select: { amount: true, frequency: true, interval: true } },
      },
    });

    return {
      currency: ctx.currency,
      budgets: budgets.map((budget) => {
        const monthly = budget.items.reduce(
          (totals, item) => {
            const perMonth = monthlyAmount(money(item.amount), item.frequency, item.interval);
            if (perMonth >= 0) totals.income += perMonth;
            else totals.expense += -perMonth;
            return totals;
          },
          { income: 0, expense: 0 },
        );
        return {
          budget: budget.name,
          // The key for every other tool, and only needed when two share a name.
          id: budget.id,
          ...roleOf(budget),
          ...windowOf(budget, ctx.now),
          origin: budget.origin === "inferred" ? "inferred from history" : "made by hand",
          items: budget.items.length,
          monthlyIncome: round2(monthly.income),
          monthlyExpense: round2(monthly.expense),
        };
      }),
    };
  },
};

export const getBudget: Tool = {
  name: "get_budget",
  description:
    "Read one budget or layer in full: the dates it applies over, the base it layers onto or the layers stacked on it, and every item — name, amount, how often it falls, and which spending area, category and payee it belongs to. Use the item ids it returns to change or remove items.",
  parameters: {
    type: "object",
    properties: {
      budget: BUDGET_KEY,
    },
    required: ["budget"],
  },
  async handler(args, ctx) {
    const found = await findBudget(ctx, asText(args.budget));
    if ("error" in found) return found;

    const layers = await ctx.db.budget.findMany({
      where: { baseBudgetId: found.budget.id },
      orderBy: { name: "asc" },
      select: { name: true, startsOn: true, endsOn: true, repeatsAnnually: true },
    });

    const items = await ctx.db.budgetItem.findMany({
      where: { budgetId: found.budget.id },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        amount: true,
        frequency: true,
        interval: true,
        anchorDate: true,
        inferred: true,
        inferredSource: true,
        basis: true,
        categoryGroup: { select: { name: true } },
        category: { select: { name: true } },
        merchant: { select: { name: true } },
      },
    });

    return {
      budget: found.budget.name,
      id: found.budget.id,
      ...roleOf(found.budget),
      ...windowOf(found.budget, ctx.now),
      // A base's layers, named so the model can go and read one, with their own dates
      // so it can see which of them a date it is being asked about falls in.
      layers: layers.map((layer) => ({
        layer: layer.name,
        ...windowOf(layer, ctx.now),
      })),
      currency: ctx.currency,
      items: items.map((item) => {
        const amount = money(item.amount);
        return {
          id: item.id,
          name: item.name,
          direction: amount >= 0 ? "income" : "expense",
          amount: Math.abs(amount),
          frequency: item.frequency,
          interval: item.interval,
          anchorDate: item.anchorDate.toISOString().slice(0, 10),
          cadence: isFrequency(item.frequency)
            ? describeRecurrence({
                frequency: item.frequency,
                interval: item.interval,
                anchorDate: item.anchorDate,
              })
            : item.frequency,
          area: item.categoryGroup.name,
          category: item.category?.name ?? null,
          merchant: item.merchant?.name ?? null,
          // Who arrived at this figure, and why. A row with no source was typed by the
          // household — say so, so the model proposes changes to it rather than
          // quietly overwriting a figure somebody chose deliberately.
          source:
            item.inferredSource === "ai"
              ? "proposed by a model"
              : item.inferredSource === "computed"
                ? "computed from history"
                : "typed by the household",
          basis: item.basis,
          // Still an untouched guess, so "re-infer from history" may replace it.
          stillAGuess: item.inferred,
        };
      }),
    };
  },
};

export const listAccounts: Tool = {
  name: "list_accounts",
  description:
    "List the household's bank accounts: name, type, currency and current balance. Balances are as at the last sync.",
  parameters: { type: "object", properties: {}, required: [] },
  async handler(_args, ctx) {
    const accounts = await ctx.db.account.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: {
        name: true,
        type: true,
        currency: true,
        balanceCurrent: true,
        balanceAvailable: true,
      },
    });
    return {
      accounts: accounts.map((account) => ({
        account: account.name,
        type: account.type,
        currency: account.currency,
        balance: round2OrNull(moneyOrNull(account.balanceCurrent)),
        available: round2OrNull(moneyOrNull(account.balanceAvailable)),
      })),
    };
  },
};

// --- Shared by the write tools too. -----------------------------------------

/** A budget as every tool here needs it: enough to write against, enough to know
 *  whether it is a base or a layer, and enough to change one end of its window
 *  without asking for the other. */
export type FoundBudget = {
  id: string;
  name: string;
  baseBudgetId: string | null;
  base: { name: string } | null;
  startsOn: Date | null;
  endsOn: Date | null;
  repeatsAnnually: boolean;
};

/**
 * Resolve a budget by name, case-insensitively, or by its id.
 *
 * Names are what a person says and what the read tools return, so a name is what
 * this takes — but a name is unique only by habit, and layers make a clash ordinary
 * rather than exotic: "Christmas" on this year's base and "Christmas" on next year's
 * are the same word for two budgets. So a name that matches more than one is an
 * error rather than a coin toss, and the way out is the id, which is the budget's
 * actual identity and the thing its page is addressed by.
 *
 * Every failure answers with the real budgets, labelled by their role, because a
 * model that can see the list fixes the call on its next turn.
 */
export async function findBudget(
  ctx: ToolContext,
  key: string,
): Promise<{ budget: FoundBudget } | { error: string; budgets: string[] }> {
  const budgets = await ctx.db.budget.findMany({
    orderBy: { name: "asc" },
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
  const known = budgets.map(
    (b) => `${b.name} (${b.base ? `layer of ${b.base.name}` : "base"}, id ${b.id})`,
  );

  const wanted = key.trim().toLowerCase();
  const named = budgets.filter((b) => b.name.toLowerCase() === wanted);
  // An id wins outright — it is the identity, not a description of one — and a name
  // that claimed two budgets is refused rather than resolved to either.
  const match = budgets.find((b) => b.id === key.trim()) ?? (named.length === 1 ? named[0] : undefined);

  if (!match) {
    if (named.length > 1) {
      return {
        error: `More than one budget is called "${key}": ${named
          .map((b) => `${b.name} (id ${b.id})`)
          .join(", ")}. Name the one you mean by its id.`,
        budgets: known,
      };
    }
    return { error: `No budget called "${key}".`, budgets: known };
  }
  return { budget: match };
}

/** Whether a budget is a base or a layer, and of what. The same two fields wherever
 *  a budget is described, so the model reads one shape. */
export function roleOf(budget: { baseBudgetId: string | null; base?: { name: string } | null }) {
  return {
    role: budget.baseBudgetId ? "layer" : "base",
    layerOf: budget.base?.name ?? null,
  };
}

/** The dates a budget applies over, said twice: as the phrase the household's own
 *  screen shows, and as the raw fields the model needs to change them. */
export function windowOf(
  budget: { startsOn: Date | null; endsOn: Date | null; repeatsAnnually: boolean },
  now: Date,
) {
  return {
    window: describeLifespan(budget),
    startsOn: budget.startsOn?.toISOString().slice(0, 10) ?? null,
    endsOn: budget.endsOn?.toISOString().slice(0, 10) ?? null,
    repeatsAnnually: budget.repeatsAnnually,
    // The question actually being asked of a layer nine times in ten.
    activeNow: activeOn(budget, now),
  };
}

/** A signed per-occurrence amount as a signed per-month one. Rough by design — it is
 *  for a model's sense of scale, not for the forecast, which does this properly in
 *  lib/budget/recurrence.ts. */
function monthlyAmount(amount: number, frequency: string, interval: number): number {
  const perMonth: Record<string, number> = {
    day: 30.44,
    week: 4.348,
    month: 1,
    quarter: 1 / 3,
    year: 1 / 12,
    once: 0,
  };
  return (amount * (perMonth[frequency] ?? 0)) / Math.max(1, interval);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round2OrNull = (n: number | null) => (n === null ? null : round2(n));

/** The read tools a chat is offered. The budget inference takes only `list_spending_areas`
 *  and `get_transactions`, plus its own `propose_items` — it is building a budget from
 *  nothing, so the existing ones are not its business, and it has no use for a per-period
 *  view of history it is about to summarise anyway. */
export const READ_TOOLS: Tool[] = [
  listSpendingAreas,
  getTransactions,
  getPeriodBreakdown,
  listBudgets,
  getBudget,
  listAccounts,
];
