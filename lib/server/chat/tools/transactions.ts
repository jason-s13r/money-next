// No `import "server-only"`: shared with the worker's budget inference. See registry.ts.
import type { Prisma } from "../../../generated/prisma/client";
import { distinctiveTokens } from "../../rules/learning/match";
import { money, moneySum } from "../../money";
import { MAX_TOOL_ROWS } from "../client";
import { readLearnedRules, matchesTransaction } from "../../rules/learning/read";
import { readRuleGraph } from "../../rules/document";
import {
  asBool,
  asDay,
  asInt,
  asNumber,
  asText,
  type Tool,
  type ToolContext,
} from "./registry";

// Reading transactions as rows, rather than as one spending area's history.
//
// `get_transactions` (read.ts) serves from the in-memory `History`, and that shape is
// right for the question it was built for — "what does this household spend on Food?" —
// but it cannot answer the questions this file exists for, and not by accident:
//
//   - **It cannot see an uncategorised row at all.** `loadHistory` buckets by spending
//     area and drops anything with no group, which is precisely the queue somebody wants
//     help working through.
//   - **It cannot see past `MAX_MONTHS`,** because that is the window it loads.
//   - **It has no ids in it.** Rows are described, not identified, since nothing the
//     inference does needs to point at one. Every write tool here needs to.
//
// So these go to the database. They are the only reads in the chat that do a query per
// call, which is the cost of being able to filter on anything and of returning rows a
// later call can act on.
//
// Amounts still come back in the household's display currency, like everywhere else, so
// a model never has to think about which account a row is held in.

/** The relations every row here carries. */
const ROW_SELECT = {
  id: true,
  date: true,
  amount: true,
  type: true,
  description: true,
  reference: true,
  particulars: true,
  code: true,
  cardSuffix: true,
  categoryId: true,
  categorySource: true,
  merchantSource: true,
  transferGroupId: true,
  category: { select: { name: true } },
  categoryGroup: { select: { name: true } },
  merchant: { select: { id: true, name: true } },
  account: { select: { name: true, currency: true } },
  labels: { select: { label: { select: { name: true } } } },
} satisfies Prisma.TransactionSelect;

type Row = Prisma.TransactionGetPayload<{ select: typeof ROW_SELECT }>;

/** Everything a model may narrow a search by, in one schema — reused by the tools that
 *  search and by the ones that count. Written out in full rather than composed, because
 *  a small model reads the tool's own parameters and nothing else. */
const FILTERS = {
  search: {
    type: "string",
    description:
      "Free text matched against the description, payee, category, reference, particulars, code and counterparty account.",
  },
  merchant: { type: "string", description: "Payee name, exactly as a tool gave it." },
  category: { type: "string", description: "Category name." },
  area: { type: "string", description: "Spending area (category group) name." },
  account: { type: "string", description: "Bank account name." },
  label: { type: "string", description: "One of the household's own tags." },
  type: {
    type: "string",
    description: "Bank transaction type: DEBIT, CREDIT, TRANSFER, EFTPOS, FEE, and so on.",
  },
  cardSuffix: { type: "string", description: "Last digits of the card used." },
  from: { type: "string", description: "YYYY-MM-DD, earliest date to include." },
  to: { type: "string", description: "YYYY-MM-DD, latest date to include. The day itself counts." },
  direction: {
    type: "string",
    enum: ["in", "out"],
    description: "in for money received, out for money spent. Both when omitted.",
  },
  minAmount: {
    type: "number",
    description: "Smallest amount to include, as a positive number regardless of direction.",
  },
  maxAmount: { type: "number", description: "Largest amount to include, positive." },
  uncategorised: {
    type: "boolean",
    description: "True for only rows with no category; false for only rows that have one.",
  },
  unlabelled: { type: "boolean", description: "True for only rows carrying no tags." },
  includeTransfers: {
    type: "boolean",
    description:
      "True to include money moved between the household's own accounts. Left out by default, since a transfer is neither income nor spending.",
  },
} as const;

export const searchTransactionsTool: Tool = {
  name: "search_transactions",
  description:
    "Find transactions by any combination of text, payee, category, spending area, account, tag, type, card, date range, direction and amount — and read them back with their ids. " +
    "This is the tool for a date range (`from`/`to` with nothing else is every transaction in that window), for finding the rows a write tool should act on, and for anything get_transactions cannot see: uncategorised rows, and anything outside one spending area. " +
    `Returns at most ${MAX_TOOL_ROWS} rows; when the result says more:true, call again with offset advanced by the number returned.`,
  parameters: {
    type: "object",
    properties: {
      ...FILTERS,
      sort: {
        type: "string",
        enum: ["date", "amount"],
        description: "date, newest first (the default), or amount, largest first.",
      },
      offset: { type: "integer", description: "Rows to skip. Default 0." },
      limit: {
        type: "integer",
        description: `Rows to return. Default 50, maximum ${MAX_TOOL_ROWS}.`,
      },
    },
    required: [],
  },
  async handler(args, ctx) {
    const where = await buildWhere(args, ctx);
    if ("error" in where) return where;

    const offset = Math.max(0, asInt(args.offset) ?? 0);
    const limit = Math.min(MAX_TOOL_ROWS, Math.max(1, asInt(args.limit) ?? 50));
    const sortByAmount = asText(args.sort).toLowerCase() === "amount";

    const [matched, rows, net] = await Promise.all([
      ctx.db.transaction.count({ where: where.where }),
      ctx.db.transaction.findMany({
        where: where.where,
        // `id` breaks every tie: institutions stamp most rows midday rather than with a
        // real time, so thousands share a date and a row would otherwise drift between
        // pages as the model works through them.
        orderBy: sortByAmount ? [{ amount: "desc" }, { id: "desc" }] : [{ date: "desc" }, { id: "desc" }],
        skip: offset,
        take: limit,
        select: ROW_SELECT,
      }),
      netOf(ctx, where.where),
    ]);

    const { currency } = await ctx.fx();
    return {
      currency,
      matched,
      offset,
      returned: rows.length,
      more: offset + rows.length < matched,
      /** The whole match, not just this page — the answer to "how much was that?" is
       *  about everything that matched, and paging through to add it up would be both
       *  slow and wrong the moment a page was missed. */
      net: round2(net),
      transactions: await describe(ctx, rows),
    };
  },
};

export const getUncategorisedTransactions: Tool = {
  name: "get_uncategorised_transactions",
  description:
    "The transactions with no category — the household's review queue — biggest first, with their ids so they can be categorised. " +
    "Transfers between their own accounts are left out, since those are neither income nor spending. " +
    "Set groupSimilar true to get them clustered by the distinctive words in their descriptions instead, which is how you categorise a whole recurring set (or propose a rule) in one go rather than a row at a time.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Optional YYYY-MM-DD lower bound on the date." },
      to: { type: "string", description: "Optional YYYY-MM-DD upper bound on the date." },
      direction: FILTERS.direction,
      groupSimilar: {
        type: "boolean",
        description:
          "True to return clusters of look-alike transactions — each with the words they share, how many there are, what they come to, and every id — instead of individual rows.",
      },
      offset: { type: "integer", description: "Rows to skip. Default 0." },
      limit: {
        type: "integer",
        description: `Rows to return. Default 50, maximum ${MAX_TOOL_ROWS}.`,
      },
    },
    required: [],
  },
  async handler(args, ctx) {
    const where = await buildWhere({ ...args, uncategorised: true }, ctx);
    if ("error" in where) return where;

    const { currency } = await ctx.fx();
    const matched = await ctx.db.transaction.count({ where: where.where });

    if (asBool(args.groupSimilar)) {
      // The whole queue, not a page of it: a cluster is only meaningful over everything
      // that could join it, and a page boundary would split a recurring set in half and
      // report each part as its own small group. The queue is the rows nobody has filed
      // yet, so it is bounded by how far behind the household is, not by their history.
      const all = await ctx.db.transaction.findMany({
        where: where.where,
        orderBy: [{ date: "desc" }, { id: "desc" }],
        select: ROW_SELECT,
      });
      return { currency, matched, groups: await clusters(ctx, all) };
    }

    const offset = Math.max(0, asInt(args.offset) ?? 0);
    const limit = Math.min(MAX_TOOL_ROWS, Math.max(1, asInt(args.limit) ?? 50));

    // Biggest first, by magnitude: this is a queue worked largest-first, and it holds
    // inflows as well as outflows — an uncategorised refund matters as much as an
    // uncategorised payment of the same size. Postgres can order by `abs()` but Prisma
    // cannot express it, so the ordering happens here, over ids only.
    const ids = await ctx.db.transaction.findMany({
      where: where.where,
      select: { id: true, amount: true },
    });
    const page = ids
      .map((row) => ({ id: row.id, amount: Math.abs(money(row.amount)) }))
      .toSorted((a, b) => b.amount - a.amount || b.id.localeCompare(a.id))
      .slice(offset, offset + limit)
      .map((row) => row.id);

    const rows = await ctx.db.transaction.findMany({
      where: { id: { in: page } },
      select: ROW_SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return {
      currency,
      matched,
      offset,
      returned: page.length,
      more: offset + page.length < matched,
      transactions: await describe(ctx, page.map((id) => byId.get(id)!).filter(Boolean)),
    };
  },
};

export const getTransaction: Tool = {
  name: "get_transaction",
  description:
    "One transaction in full, by id: every field the bank sent, what it is categorised as and who set that, its tags, any unresolved disagreement between the household and the bank about it, and which learned rules match it. Read this before changing a row you are unsure about.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The transaction id." } },
    required: ["id"],
  },
  async handler(args, ctx) {
    const id = asText(args.id);
    const row = await ctx.db.transaction.findFirst({
      where: { id },
      select: {
        ...ROW_SELECT,
        otherAccount: true,
        balance: true,
        conflicts: {
          where: { status: "open" },
          select: {
            field: true,
            heldSource: true,
            userValueLabel: true,
            akahuValueLabel: true,
          },
        },
      },
    });
    if (!row) {
      return { error: `No transaction with id "${id}".` };
    }

    const [described] = await describe(ctx, [row]);
    // Which rules already claim this row, so a model about to write a new one can see
    // it would be redundant — and so "why did this get that category?" is answerable.
    const rules = readLearnedRules(await readRuleGraph(ctx.db)).filter((rule) =>
      matchesTransaction(rule.match, row),
    );

    return {
      ...described,
      otherAccount: row.otherAccount,
      // An open disagreement between what the household (or their rules) decided and
      // what a later sync reported. The kept value is winning and stays winning; this
      // is here so a model does not "correct" a field somebody deliberately defended.
      conflicts: row.conflicts.map((conflict) => ({
        field: conflict.field,
        kept: conflict.userValueLabel,
        keptBy: conflict.heldSource === "rule" ? "one of their rules" : "the household",
        theBankSays: conflict.akahuValueLabel,
      })),
      matchedByRules: rules.map((rule) => ({ id: rule.id, words: rule.match.tokens })),
    };
  },
};

// --- Shared. ----------------------------------------------------------------

/**
 * The filter arguments as one Prisma `where`.
 *
 * Names are resolved here rather than in each tool, and a name that matches nothing is
 * an *error* rather than a filter that matches nothing — the difference between "you
 * have no transactions at Countdow" and "there is no payee called Countdow" is the
 * difference between a model reporting a confident falsehood and it fixing a typo.
 *
 * Exported for the tests, which pin the amount bounds: those are the one part of this
 * that is wrong in a way nothing would notice — a filter that quietly matches the wrong
 * side of zero returns rows, just not the right ones.
 */
export async function buildWhere(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ error: string; [hint: string]: unknown } | { where: Prisma.TransactionWhereInput }> {
  const and: Prisma.TransactionWhereInput[] = [];

  const search = asText(args.search);
  if (search) {
    and.push({
      // Every branch must be `insensitive`: Postgres' LIKE is case-sensitive, and banks
      // write most descriptions in capitals. The insensitive form is what the trigram
      // indexes on these columns are for, so this stays indexed rather than scanning.
      OR: [
        ...(["description", "particulars", "code", "reference", "otherAccount"] as const).map(
          (field) => ({ [field]: { contains: search, mode: "insensitive" as const } }),
        ),
        { merchant: { is: { name: { contains: search, mode: "insensitive" } } } },
        { category: { is: { name: { contains: search, mode: "insensitive" } } } },
      ],
    });
  }

  for (const [arg, build] of [
    ["merchant", (name: string) => ({ merchant: { is: named(name) } })],
    ["category", (name: string) => ({ category: { is: named(name) } })],
    ["area", (name: string) => ({ categoryGroup: { is: named(name) } })],
    ["account", (name: string) => ({ account: { is: named(name) } })],
    ["label", (name: string) => ({ labels: { some: { label: { is: named(name) } } } })],
  ] as const) {
    const value = asText(args[arg]);
    if (!value) continue;
    const exists = await nameExists(ctx, arg, value);
    if (exists) return exists;
    and.push(build(value));
  }

  const type = asText(args.type);
  if (type) and.push({ type: type.toUpperCase() });

  const cardSuffix = asText(args.cardSuffix);
  if (cardSuffix) and.push({ cardSuffix });

  // Dates are compared as instants but named as days, and a bank stamps a row at midday
  // rather than at midnight — so the upper bound has to be the *end* of the day it
  // names, or "to: 2026-07-31" would silently drop everything that happened on the 31st.
  const from = asDay(args.from);
  const to = asDay(args.to);
  for (const [key, value] of [["from", args.from], ["to", args.to]] as const) {
    if (asText(value) && !(key === "from" ? from : to)) {
      return { error: `${key} "${String(value)}" is not a date. Write it as YYYY-MM-DD.` };
    }
  }
  if (from) and.push({ date: { gte: new Date(`${from}T00:00:00.000Z`) } });
  if (to) and.push({ date: { lte: new Date(`${to}T23:59:59.999Z`) } });

  const direction = asText(args.direction).toLowerCase();
  const min = asNumber(args.minAmount);
  const max = asNumber(args.maxAmount);
  if (direction && direction !== "in" && direction !== "out") {
    return { error: `direction must be "in" or "out", not "${direction}".` };
  }
  // Amounts are signed in the column and unsigned in the argument, so the bounds swap
  // and invert for money out. Without a direction there is nothing to invert against, so
  // a bound applies to both sides of zero.
  if (direction === "in") and.push({ amount: { gt: 0 } });
  if (direction === "out") and.push({ amount: { lt: 0 } });
  if (min !== null || max !== null) {
    const lo = min === null ? null : Math.abs(min);
    const hi = max === null ? null : Math.abs(max);
    if (direction === "out") {
      and.push({ amount: { ...(lo !== null ? { lte: -lo } : {}), ...(hi !== null ? { gte: -hi } : {}) } });
    } else if (direction === "in") {
      and.push({ amount: { ...(lo !== null ? { gte: lo } : {}), ...(hi !== null ? { lte: hi } : {}) } });
    } else {
      and.push({
        OR: [
          { amount: { ...(lo !== null ? { gte: lo } : {}), ...(hi !== null ? { lte: hi } : {}) } },
          { amount: { ...(lo !== null ? { lte: -lo } : {}), ...(hi !== null ? { gte: -hi } : {}) } },
        ],
      });
    }
  }

  if (args.uncategorised !== undefined) {
    and.push(asBool(args.uncategorised) ? { categoryId: null } : { categoryId: { not: null } });
  }
  if (asBool(args.unlabelled)) and.push({ labels: { none: {} } });

  // Both halves of "is this a transfer": the type Akahu tags, and a group somebody
  // linked by hand. The same test the rest of the app uses.
  if (!asBool(args.includeTransfers)) {
    and.push({ transferGroupId: null, type: { notIn: ["TRANSFER"] } });
  }

  return { where: and.length > 0 ? { AND: and } : {} };
}

const named = (name: string) => ({ name: { equals: name, mode: "insensitive" as const } });

/** Whether a name the model filtered on exists at all, as an error with the real list
 *  when it does not. Null when it is fine. */
async function nameExists(
  ctx: ToolContext,
  kind: "merchant" | "category" | "area" | "account" | "label",
  name: string,
): Promise<{ error: string; [hint: string]: unknown } | null> {
  // Prisma's delegates are separate types with separate argument types, so this is five
  // closures rather than one table keyed by name — the union of the delegates is not
  // callable, and forcing it to be would cost the argument checking that makes these
  // queries safe in the first place.
  //
  // `whole` is the difference between the short vocabularies and the long ones: naming
  // all six hundred merchants back at the model would cost more context than the search
  // it is trying to run, while a household has a dozen spending areas and can be shown
  // every one of them.
  const of = {
    merchant: {
      whole: false,
      one: (where: NameWhere) => ctx.db.merchant.findFirst({ where, select: NAME }),
      many: (where: NameWhere) => ctx.db.merchant.findMany({ ...LIST, where, select: NAME }),
    },
    category: {
      whole: false,
      one: (where: NameWhere) => ctx.db.category.findFirst({ where, select: NAME }),
      many: (where: NameWhere) => ctx.db.category.findMany({ ...LIST, where, select: NAME }),
    },
    area: {
      whole: true,
      one: (where: NameWhere) => ctx.db.categoryGroup.findFirst({ where, select: NAME }),
      many: (where: NameWhere) => ctx.db.categoryGroup.findMany({ ...LIST, where, select: NAME }),
    },
    account: {
      whole: true,
      one: (where: NameWhere) => ctx.db.account.findFirst({ where, select: NAME }),
      many: (where: NameWhere) => ctx.db.account.findMany({ ...LIST, where, select: NAME }),
    },
    label: {
      whole: true,
      one: (where: NameWhere) => ctx.db.label.findFirst({ where, select: NAME }),
      many: (where: NameWhere) => ctx.db.label.findMany({ ...LIST, where, select: NAME }),
    },
  }[kind];

  if (await of.one(named(name))) return null;

  const label = kind === "area" ? "spending area" : kind;
  const error = `No ${label} called "${name}".`;

  if (of.whole) {
    const all = await of.many({});
    return { error, [`${kind}s`]: all.map((row) => row.name) };
  }

  const near = await of.many({ name: { contains: name.split(/\s+/)[0], mode: "insensitive" } });
  return {
    error,
    ...(near.length > 0 ? { didYouMean: near.slice(0, 20).map((row) => row.name) } : {}),
  };
}

/** The one column any of these lookups reads, and the one order they read it in. */
const NAME = { name: true } as const;
const LIST = { orderBy: { name: "asc" } } as const;
type NameWhere = { name?: Prisma.StringFilter | string };

/** Rows as the model reads them: display currency, names instead of ids for everything
 *  except the row itself, which it needs an id for in order to change it. */
async function describe(ctx: ToolContext, rows: Row[]) {
  const { toDisplay } = await ctx.fx();
  return rows.map((row) => ({
    id: row.id,
    date: row.date.toISOString().slice(0, 10),
    amount: round2(toDisplay(money(row.amount), row.account.currency, row.date)),
    type: row.type,
    description: row.description,
    area: row.categoryGroup?.name ?? null,
    category: row.category?.name ?? null,
    merchant: row.merchant?.name ?? null,
    account: row.account.name,
    labels: row.labels.map((join) => join.label.name),
    reference: row.reference,
    particulars: row.particulars,
    code: row.code,
    cardSuffix: row.cardSuffix,
    // Who owns each field now, which is what says whether changing it is filling a gap
    // or overruling somebody. `user` means a person set it deliberately.
    setBy: { category: row.categorySource, merchant: row.merchantSource },
    isTransfer: row.transferGroupId !== null || row.type === "TRANSFER",
  }));
}

/**
 * Look-alike transactions, clustered by the distinctive words in their descriptions.
 *
 * The same tokens a learned rule keys on (`distinctiveTokens`), deliberately: a cluster
 * here is the set of rows a rule derived from any one of them would go on to match, so
 * what the model sees is what a rule would do. Rows whose descriptions are all dates and
 * reference numbers have no distinctive word to cluster on and are returned as their own
 * ungrouped bucket rather than silently dropped — they are exactly the rows a rule could
 * never cover, and somebody has to file them by hand.
 */
async function clusters(ctx: ToolContext, rows: Row[]) {
  const { toDisplay } = await ctx.fx();
  const groups = new Map<string, { words: string[]; rows: Row[]; total: number }>();
  const ungrouped: Row[] = [];

  for (const row of rows) {
    const words = distinctiveTokens(row.description);
    if (words.length === 0) {
      ungrouped.push(row);
      continue;
    }
    const key = `${row.type}|${[...words].sort().join(" ")}`;
    const group = groups.get(key) ?? { words, rows: [], total: 0 };
    group.rows.push(row);
    group.total += toDisplay(money(row.amount), row.account.currency, row.date);
    groups.set(key, group);
  }

  const described = [...groups.values()]
    .sort((a, b) => b.rows.length - a.rows.length || Math.abs(b.total) - Math.abs(a.total))
    .map((group) => ({
      words: group.words,
      count: group.rows.length,
      total: round2(group.total),
      from: group.rows[group.rows.length - 1].date.toISOString().slice(0, 10),
      to: group.rows[0].date.toISOString().slice(0, 10),
      example: group.rows[0].description,
      type: group.rows[0].type,
      ids: group.rows.map((row) => row.id),
    }));

  return {
    similar: described,
    ...(ungrouped.length > 0
      ? {
          noSharedWords: {
            count: ungrouped.length,
            note: "Nothing stable to match on — these have to be categorised individually, and no rule can cover them.",
            ids: ungrouped.map((row) => row.id),
          },
        }
      : {}),
  };
}

/**
 * What a filter's whole result comes to, in the display currency.
 *
 * Summed per account and converted per subtotal rather than as one SQL sum, which would
 * add NZD, AUD and CHF together as if they were one number. The same fold
 * `netInDisplay` does on the request side; it lives here again because that one reaches
 * for the ambient request client, which a detached chat turn does not have.
 */
async function netOf(ctx: ToolContext, where: Prisma.TransactionWhereInput): Promise<number> {
  const byAccount = await ctx.db.transaction.groupBy({
    by: ["accountId"],
    where,
    _sum: { amount: true },
  });
  if (byAccount.length === 0) return 0;

  const accounts = await ctx.db.account.findMany({
    where: { id: { in: byAccount.map((row) => row.accountId) } },
    select: { id: true, currency: true },
  });
  const currencyById = new Map(accounts.map((a) => [a.id, a.currency]));
  const { toDisplay } = await ctx.fx();

  // At today's rate, not each row's: a total over a date range has no one date to
  // convert at, and valuing the whole thing in today's money is both the honest reading
  // and the one the listings show.
  let net = 0;
  for (const row of byAccount) {
    net += toDisplay(moneySum(row._sum.amount), currencyById.get(row.accountId) ?? null, ctx.now);
  }
  return net;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The transaction reads a chat is offered. The budget inference takes none of them —
 *  it works one spending area at a time out of the history it already holds. */
export const TRANSACTION_READ_TOOLS: Tool[] = [
  searchTransactionsTool,
  getUncategorisedTransactions,
  getTransaction,
];
