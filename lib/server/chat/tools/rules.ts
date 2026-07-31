// No `import "server-only"`: it sits in the same registry as the tools the worker
// loads. See the note at the top of registry.ts.
import type { Prisma } from "../../../generated/prisma/client";
import { enqueueRules } from "../../queue";
import { editRuleGraph, readRuleGraph } from "../../rules/document";
import { deriveMatch, distinctiveTokens, type DerivedMatch } from "../../rules/learning/match";
import { deleteLearnedRule, readLearnedRules } from "../../rules/learning/read";
import { readTransferAutoLink } from "../../rules/learning/transfers";
import { upsertLearnedRule } from "../../rules/learning/upsert";
import { money } from "../../money";
import { findCategory, findMerchant, isError } from "./lookup";
import { asInt, asText, type Tool, type ToolContext } from "./registry";

// The standing rules that categorise new transactions as they arrive.
//
// A rule is a row in the "Learned rules" decision table of the workspace's one active
// `RuleDocument` — a GoRules decision graph. The table's shape is fixed and narrow on
// purpose: a predicate over the transaction's `type` and the words in its description,
// and an output of a category, a merchant, or both. That is the whole vocabulary these
// tools expose, and it is the same one the "make a rule from this" button on the
// transaction page produces, so a rule made in conversation is indistinguishable from
// one made by hand and is editable on the same screen.
//
// **Nothing here evaluates a rule.** The engine is `@gorules/zen-engine`, a native
// addon, and it runs in the worker over a whole `RuleRun`. `preview_rule` therefore
// counts what a predicate *would* match with an equivalent database query rather than
// by asking the engine — the same trick `generateRuleFromTransaction` uses, and for the
// same reason: knowing the blast radius before writing is the difference between a
// rule and an accident.
//
// **Writing a rule does not apply it.** It governs what arrives from the next sync on.
// `apply_rules` is what reaches back over everything already there, and it is queued
// rather than run, because a whole-history pass is unbounded work and belongs to the
// worker (see `enqueueRules`).

export const listRules: Tool = {
  name: "list_rules",
  description:
    "The household's standing rules: what each one matches on and what it sets. These run over every transaction as it arrives, so they are how a categorisation sticks for next month as well as this one. Use the ids to remove one.",
  parameters: { type: "object", properties: {}, required: [] },
  async handler(_args, ctx) {
    const graph = await readRuleGraph(ctx.db);
    const rules = readLearnedRules(graph);
    const names = await nameLookups(ctx, rules);

    return {
      rules: rules.map((rule) => ({
        id: rule.id,
        // Evaluation is first-match-wins, so where a rule sits decides what it can
        // reach. A model proposing a narrower rule beside a broad one needs to know
        // this list is ordered.
        matches: rule.match.structured
          ? {
              type: rule.match.type,
              words: rule.match.tokens,
              meaning: describeMatch(rule.match.type, rule.match.tokens),
            }
          : { handWritten: rule.match.raw },
        setsCategory: rule.categoryId ? (names.categories.get(rule.categoryId) ?? rule.categoryId) : null,
        setsMerchant: rule.merchantId ? (names.merchants.get(rule.merchantId) ?? rule.merchantId) : null,
      })),
      order: "First match wins: a rule earlier in this list beats a later one on the same transaction.",
      autoLinkTransfers: readTransferAutoLink(graph),
    };
  },
};

export const previewRule: Tool = {
  name: "preview_rule",
  description:
    "What a rule would match, before you write it: how many transactions it captures, what they are categorised as now, and a sample of them. " +
    "Give a transaction id to see the rule that would be derived from it, or give the words yourself. " +
    "Always do this before create_rule and tell the household the number — a rule keyed on a word that turns out to be common is how a whole ledger gets miscategorised at once.",
  parameters: {
    type: "object",
    properties: {
      fromTransaction: {
        type: "string",
        description:
          "A transaction id. The rule's words are derived from its description, the same way the household's own 'make a rule from this' button does it.",
      },
      words: {
        type: "array",
        items: { type: "string" },
        description:
          "The words a description must ALL contain, instead of deriving them. Lower case, no apostrophes.",
      },
      type: {
        type: "string",
        description: "The bank transaction type to gate on: DEBIT, CREDIT, EFTPOS, and so on.",
      },
      sample: { type: "integer", description: "How many example transactions to return. Default 5, maximum 20." },
    },
    required: [],
  },
  async handler(args, ctx) {
    const match = await readMatch(args, ctx);
    if ("error" in match) return match;
    return { ...(await preview(ctx, match.match, asInt(args.sample) ?? 5)), wouldMatchOn: match.match.expression };
  },
};

export const createRule: Tool = {
  name: "create_rule",
  description:
    "Write a standing rule so this categorisation happens by itself from now on. " +
    "The usual way is fromTransaction: point at a transaction you have already categorised correctly, and the rule takes its words from that description and its category and payee from the row itself. " +
    "Check preview_rule first and tell the household how many transactions it reaches. This governs what arrives from the next sync onwards; call apply_rules to reach back over what is already there.",
  write: "enrichment",
  parameters: {
    type: "object",
    properties: {
      fromTransaction: {
        type: "string",
        description:
          "A correctly categorised transaction to learn from. Its category and payee become the rule's outputs unless you override them below.",
      },
      words: {
        type: "array",
        items: { type: "string" },
        description: "The words a description must ALL contain, if you are not deriving them.",
      },
      type: { type: "string", description: "The bank transaction type to gate on." },
      category: { type: "string", description: "The category to set. Omit to leave the category alone." },
      area: { type: "string", description: "The category's spending area, when its name is used in more than one." },
      merchant: { type: "string", description: "The payee to set. Omit to leave the payee alone." },
    },
    required: [],
  },
  async handler(args, ctx) {
    const match = await readMatch(args, ctx);
    if ("error" in match) return match;

    // Outputs come from the arguments when given and from the source transaction
    // otherwise, which is what makes `fromTransaction` on its own the one-argument call
    // it is meant to be.
    let categoryId = match.source?.categoryId ?? null;
    let categoryName = match.source?.category?.name ?? null;
    if (asText(args.category)) {
      const found = await findCategory(ctx, asText(args.category), asText(args.area) || undefined);
      if (isError(found)) return found;
      categoryId = found.found.id;
      categoryName = found.found.name;
    }

    let merchantId = match.source?.merchantId ?? null;
    let merchantName = match.source?.merchant?.name ?? null;
    if (asText(args.merchant)) {
      const found = await findMerchant(ctx, asText(args.merchant), false);
      if (isError(found)) return found;
      merchantId = found.found.id;
      merchantName = found.found.name;
    }

    // A rule that decides nothing is worse than no rule: it matches, wins the
    // first-match race, and sets nothing — so a later rule that would have helped never
    // gets a look.
    if (!categoryId && !merchantId) {
      return {
        error:
          "A rule has to set something. Give a category or a payee — or categorise the source transaction first, and this will take them from it.",
      };
    }

    let merged = false;
    await editRuleGraph(ctx.db, (graph) => {
      const result = upsertLearnedRule(graph, match.match, {
        categoryId,
        merchantId,
        // What the row is called on the /rules screen. The payee reads better than the
        // category there, since that is what a person recognises the rule by.
        label: merchantName ?? categoryName ?? undefined,
      });
      merged = result.merged;
    });

    const reach = await preview(ctx, match.match, 0);
    return {
      rule: {
        type: match.match.type,
        words: match.match.tokens,
        meaning: describeMatch(match.match.type, match.match.tokens),
        setsCategory: categoryName,
        setsMerchant: merchantName,
      },
      // Folded into an existing row, or broadened one that was narrower, rather than
      // added beside it — see `upsertLearnedRule`. Worth saying: "created" would be a
      // lie the household could not check without opening the rules screen.
      merged,
      matchesNow: reach.matches,
      note: `This applies to transactions arriving from now on. Call apply_rules to run it over the ${reach.matches} already here.`,
    };
  },
};

export const deleteRule: Tool = {
  name: "delete_rule",
  description:
    "Remove a standing rule, by the id list_rules gave it. Transactions it already categorised keep what it gave them — deleting a rule stops it acting in future, it does not undo the past.",
  write: "enrichment",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The rule id, as list_rules gave it." } },
    required: ["id"],
  },
  async handler(args, ctx) {
    const id = asText(args.id);
    const before = readLearnedRules(await readRuleGraph(ctx.db));
    const rule = before.find((row) => row.id === id);
    if (!rule) {
      return { error: `No rule with id "${id}".`, rules: before.map((row) => row.id) };
    }

    await editRuleGraph(ctx.db, (graph) => deleteLearnedRule(graph, id));
    return { deleted: id, wasMatching: rule.match.tokens };
  },
};

export const applyRules: Tool = {
  name: "apply_rules",
  description:
    "Run every standing rule over the transactions already in the household's history, not just the ones arriving next. " +
    "This is a background job — it is queued here and finishes on its own, so say that rather than reporting what it changed. It can recategorise a lot at once, so get a yes first.",
  write: "enrichment",
  parameters: { type: "object", properties: {}, required: [] },
  async handler(_args, ctx) {
    // Coalesced per workspace by `enqueueRules`: a pass already waiting is reused, so
    // asking twice does not queue the same work twice.
    const { existing } = await enqueueRules(ctx.db, { trigger: "manual", clearBackoff: true });
    return {
      queued: true,
      note: existing
        ? "A rules pass was already waiting; this rides along with it. It runs in the background — the results will show on the household's rules screen."
        : "Queued. It runs in the background — the results will show on the household's rules screen.",
    };
  },
};

// --- Shared. ----------------------------------------------------------------

/** The transaction a rule is being derived from, when there is one. */
type Source = {
  id: string;
  type: string;
  description: string;
  categoryId: string | null;
  category: { name: string } | null;
  merchantId: string | null;
  merchant: { name: string } | null;
};

/**
 * The predicate a call is about: derived from a transaction, or spelled out.
 *
 * Deriving is the path worth defending. `deriveMatch` drops banking boilerplate
 * ("payment", "eftpos", "visa") and anything mostly digits, because a rule keyed on a
 * reference number matches one transaction and a rule keyed on "payment" matches half
 * the ledger. A model writing its own words has neither guard, so the same filter runs
 * over what it sends and it is told what was dropped — an explicit list is an override
 * of the tokeniser, not of the reasoning behind it.
 */
async function readMatch(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ error: string; [hint: string]: unknown } | { match: DerivedMatch; source: Source | null }> {
  const from = asText(args.fromTransaction);

  if (from) {
    const source = await ctx.db.transaction.findFirst({
      where: { id: from },
      select: {
        id: true,
        type: true,
        description: true,
        categoryId: true,
        category: { select: { name: true } },
        merchantId: true,
        merchant: { select: { name: true } },
      },
    });
    if (!source) return { error: `No transaction with id "${from}".` };

    const derived = deriveMatch(source);
    if (!derived) {
      return {
        error:
          "There is no stable word in that description to match on — it is all dates and reference numbers. " +
          "A rule cannot cover this one; it has to be categorised by hand, or from a different transaction of the same kind.",
        description: source.description,
      };
    }
    return { match: derived, source };
  }

  const given = Array.isArray(args.words) ? args.words.map((word) => asText(word).toLowerCase()) : [];
  const words = given.filter((word) => word !== "");
  if (words.length === 0) {
    return { error: "Give either fromTransaction or words." };
  }
  // Single quotes end a clause in the generated expression, so a word carrying one would
  // write a predicate that does not parse — or, worse, one that parses into something
  // else.
  const unquotable = words.filter((word) => word.includes("'"));
  if (unquotable.length > 0) {
    return { error: `A rule word cannot contain an apostrophe: ${unquotable.join(", ")}.` };
  }

  const type = asText(args.type).toUpperCase();
  if (!type) {
    return {
      error:
        "A rule needs a transaction type as well as its words — an unqualified word match would catch refunds and fees alongside the payments you mean.",
      types: await knownTypes(ctx),
    };
  }

  const usable = words.filter((word) => distinctiveTokens(word, 1).length > 0);
  const dropped = words.filter((word) => !usable.includes(word));
  if (usable.length === 0) {
    return {
      error: `None of those words can key a rule: ${dropped.join(", ")}. They are either banking boilerplate that matches half the ledger, or mostly digits, which change every transaction.`,
    };
  }

  return {
    match: {
      expression: [
        `type == '${type}'`,
        ...usable.map((word) => `contains(lower(description), '${word}')`),
      ].join(" and "),
      type,
      tokens: usable,
    },
    source: null,
  };
}

/**
 * What a predicate reaches, counted against the database.
 *
 * `mode: "insensitive"` is what makes the count *true* rather than merely consistent:
 * the rule itself matches on `contains(lower(description), …)`, so a case-sensitive
 * count would promise a smaller blast radius than the rule actually has — and bank
 * descriptions are mostly capitals, so it would promise nearly zero.
 */
async function preview(ctx: ToolContext, match: DerivedMatch, sample: number) {
  const where: Prisma.TransactionWhereInput = {
    type: match.type,
    AND: match.tokens.map((token) => ({
      description: { contains: token, mode: "insensitive" as const },
    })),
  };

  const take = Math.min(20, Math.max(0, sample));
  const [matches, rows, byCategory] = await Promise.all([
    ctx.db.transaction.count({ where }),
    take > 0
      ? ctx.db.transaction.findMany({
          where,
          orderBy: [{ date: "desc" }, { id: "desc" }],
          take,
          select: {
            id: true,
            date: true,
            amount: true,
            description: true,
            category: { select: { name: true } },
            merchant: { select: { name: true } },
            account: { select: { currency: true } },
          },
        })
      : Promise.resolve([]),
    // What those rows say now. A rule that would overwrite three different categories is
    // one that has caught more than the model meant it to, and this is the cheapest way
    // to see that without reading every row.
    ctx.db.transaction.groupBy({ by: ["categoryId"], where, _count: { _all: true } }),
  ]);

  const categoryNames = await ctx.db.category.findMany({
    where: { id: { in: byCategory.map((row) => row.categoryId).filter((id): id is string => !!id) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(categoryNames.map((row) => [row.id, row.name]));
  const { toDisplay, currency } = await ctx.fx();

  return {
    matches,
    words: match.tokens,
    type: match.type,
    meaning: describeMatch(match.type, match.tokens),
    currency,
    categorisedNow: Object.fromEntries(
      byCategory
        .sort((a, b) => b._count._all - a._count._all)
        .map((row) => [
          row.categoryId ? (nameById.get(row.categoryId) ?? row.categoryId) : "uncategorised",
          row._count._all,
        ]),
    ),
    ...(take > 0
      ? {
          examples: rows.map((row) => ({
            id: row.id,
            date: row.date.toISOString().slice(0, 10),
            amount: Math.round(toDisplay(money(row.amount), row.account.currency, row.date) * 100) / 100,
            description: row.description,
            category: row.category?.name ?? null,
            merchant: row.merchant?.name ?? null,
          })),
        }
      : {}),
  };
}

/** The rule in a sentence, so a model can repeat it to somebody without translating a
 *  predicate for them. */
function describeMatch(type: string | null, tokens: string[]): string {
  const words = tokens.map((token) => `"${token}"`).join(" and ");
  const kind = type ? `${type} transactions` : "transactions";
  return tokens.length > 0
    ? `${kind} whose description contains ${words}`
    : `every one of the ${kind}`;
}

/** Category and merchant names for the ids a rule table holds. Two queries for the whole
 *  list rather than one per rule. */
async function nameLookups(ctx: ToolContext, rules: { categoryId: string | null; merchantId: string | null }[]) {
  const categoryIds = rules.map((rule) => rule.categoryId).filter((id): id is string => !!id);
  const merchantIds = rules.map((rule) => rule.merchantId).filter((id): id is string => !!id);

  const [categories, merchants] = await Promise.all([
    categoryIds.length > 0
      ? ctx.db.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    merchantIds.length > 0
      ? ctx.db.merchant.findMany({ where: { id: { in: merchantIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);

  return {
    categories: new Map(categories.map((row) => [row.id, row.name])),
    merchants: new Map(merchants.map((row) => [row.id, row.name])),
  };
}

/** The transaction types this household actually has, for the error that asks for one. */
async function knownTypes(ctx: ToolContext): Promise<string[]> {
  const rows = await ctx.db.transaction.groupBy({ by: ["type"], _count: { _all: true } });
  return rows.sort((a, b) => b._count._all - a._count._all).map((row) => row.type);
}

export const RULE_READ_TOOLS: Tool[] = [listRules, previewRule];

export const RULE_WRITE_TOOLS: Tool[] = [createRule, deleteRule, applyRules];
