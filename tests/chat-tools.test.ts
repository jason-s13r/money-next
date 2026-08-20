/**
 * The parts of the chat that decide what a model may do, and what it is shown.
 *
 *   pnpm test
 *
 * Three properties, all of them silent when broken. A tool call that fails must come
 * back as a *value* — the whole loop is built on the model reading its own error and
 * fixing it next turn, and an exception instead ends the conversation. A write tool
 * must be unreachable for a caller who may not write, whether or not it was offered.
 * And a rehydrated thread must keep every tool result paired with the call it answers,
 * because the endpoint rejects one that is not — which would surface as "the chat
 * stopped working after a while", the length of the thread being the only clue.
 *
 * No network and no database: the tools are built against a stub context, exactly the
 * shape the route handler builds from a real one, and run the way the SDK runs them.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";

import {
  asBool,
  asIds,
  availableTools,
  repairLooseToolCall,
  toolsForSdk,
  type Permissions,
  type Tool,
  type ToolContext,
} from "../lib/server/chat/tools/registry";
import { DEFAULT_TAX_YEAR } from "../lib/periods";
import { buildWhere } from "../lib/server/chat/tools/transactions";
import {
  areaBreakdown,
  getPeriodBreakdown,
  totalsBreakdown,
} from "../lib/server/chat/tools/metrics";
import type {
  Comparison,
  PeriodBreakdown,
  SpendDetail,
} from "../lib/server/metrics/comparison/types";
import { elisionsFor, toModelMessages, type StoredMessage } from "../lib/chat/thread";
import { compactionCut } from "../lib/chat/compact";
import { commandMenu, parseCommand } from "../lib/chat/commands";
import { titleFrom } from "../lib/chat/messages";

/** A context with nothing real in it. Every tool below ignores it; the ones that would
 *  not are the ones that need a database and are not unit-testable by design. */
const context = (can: Permissions): ToolContext =>
  ({
    db: null,
    now: new Date("2026-07-30T00:00:00Z"),
    currency: "NZD",
    fx: async () => {
      throw new Error("fx should not be read by these tools");
    },
    catalog: { groups: new Map(), categories: new Map(), merchants: new Map() },
    history: async () => {
      throw new Error("history should not be read by these tools");
    },
    can,
    actorUserId: null,
  }) as unknown as ToolContext;

const ALL: Permissions = { budget: true, enrichment: true };
const NONE: Permissions = { budget: false, enrichment: false };

const reader: Tool = {
  name: "read_thing",
  description: "Reads a thing.",
  parameters: { type: "object", properties: {}, required: [] },
  handler: (args, _ctx, meta) => ({ ok: true, args, answering: meta.toolCallId }),
};

const writer: Tool = {
  name: "write_thing",
  description: "Writes a thing.",
  write: "budget",
  parameters: { type: "object", properties: {}, required: [] },
  handler: () => ({ written: true }),
};

const enricher: Tool = {
  name: "enrich_thing",
  description: "Recategorises a thing.",
  write: "enrichment",
  parameters: { type: "object", properties: {}, required: [] },
  handler: () => ({ enriched: true }),
};

const thrower: Tool = {
  name: "explode",
  description: "Throws.",
  parameters: { type: "object", properties: {}, required: [] },
  handler: () => {
    throw new Error("relation \"Transaction\" does not exist");
  },
};

const tools = [reader, writer, enricher, thrower];

describe("availableTools hides what the caller may not do", () => {
  test("an editor holding both grants is offered everything", () => {
    assert.equal(availableTools(tools, ALL).length, 4);
  });

  test("a viewer is offered only the read tools", () => {
    const names = availableTools(tools, NONE).map((t) => t.name);
    assert.deepEqual(names, ["read_thing", "explode"]);
  });

  test("the two write grants are offered apart", () => {
    // `budget` and `enrichment` are separate statements (lib/server/auth/roles.ts), so
    // somebody who may recategorise a transaction but not rewrite the household's plan
    // must see exactly one of the two write halves. One boolean could not say this, and
    // the failure would be silent: a tool offered that the model is then refused.
    assert.deepEqual(
      availableTools(tools, { budget: false, enrichment: true }).map((t) => t.name),
      ["read_thing", "enrich_thing", "explode"],
    );
    assert.deepEqual(
      availableTools(tools, { budget: true, enrichment: false }).map((t) => t.name),
      ["read_thing", "write_thing", "explode"],
    );
  });

  test("the hand-written schema is handed to the SDK verbatim, not regenerated", () => {
    // The schemas are tuned for models small enough to be confused by a faithful one.
    // A Zod rewrite would quietly retune every tool in the app, and nothing would fail.
    const set = toolsForSdk([reader], context(ALL));
    assert.equal(set.read_thing.description, "Reads a thing.");
    const schema = set.read_thing.inputSchema as { jsonSchema: unknown };
    assert.deepEqual(schema.jsonSchema, { type: "object", properties: {}, required: [] });
  });
});

describe("a bound tool answers with a value, never an exception", () => {
  /** Run one tool out of the set the SDK is handed, the way the SDK runs it. */
  async function run(name: string, can: Permissions, args: Record<string, unknown> = {}) {
    const execute = toolsForSdk(tools, context(can))[name]?.execute;
    assert.ok(execute, `${name} is not in the set`);
    const options = { toolCallId: "call_1", messages: [] } as never;
    return (await execute(args, options)) as Record<string, unknown>;
  }

  test("the handler is told which call it is answering", async () => {
    // The budget inference keys its in-flight elision on this id: without it a served
    // page can never be found again, and a long run quietly runs the context out.
    assert.deepEqual(await run("read_thing", ALL, { area: "Food" }), {
      ok: true,
      args: { area: "Food" },
      answering: "call_1",
    });
  });

  test("a write tool is refused for a caller who may not write", async () => {
    // Belt as well as braces: `availableTools` would not have offered it, but a model
    // that calls it anyway must be refused rather than obeyed.
    const result = await run("write_thing", NONE);
    assert.match(String(result.error), /do not have permission/);
  });

  test("a write tool is refused for a caller holding only the other grant", async () => {
    // The one that would go wrong quietly: an enrichment editor is offered — and so is
    // tempted by — nothing budget-shaped, but a model that names one anyway must not be
    // let through on the strength of holding *some* write permission.
    const result = await run("write_thing", { budget: false, enrichment: true });
    assert.match(String(result.error), /budgets/);
    assert.deepEqual(await run("enrich_thing", { budget: false, enrichment: true }), {
      enriched: true,
    });
  });

  test("a write tool runs for a caller who may", async () => {
    assert.deepEqual(await run("write_thing", ALL), { written: true });
  });

  test("a handler that throws is caught, and its message is not passed on", async () => {
    const result = await run("explode", ALL);
    assert.match(String(result.error), /explode failed/);
    // A Prisma error names tables and columns; the model has no business seeing them.
    assert.doesNotMatch(String(result.error), /Transaction/);
  });
});

describe("tool arguments survive how a small model writes them", () => {
  test("a list of ids tolerates the brackets being left off", () => {
    // Both seen from local models: one id as a bare string, several as one comma-joined
    // string. Neither is what the schema asks for, and both plainly mean what they say.
    assert.deepEqual(asIds("trans_1"), ["trans_1"]);
    assert.deepEqual(asIds("trans_1, trans_2"), ["trans_1", "trans_2"]);
    assert.deepEqual(asIds(["trans_1", " trans_2 "]), ["trans_1", "trans_2"]);
  });

  test("a repeated id is counted once", () => {
    // Every write tool reports how many rows it touched. A list naming the same row
    // twice would inflate that, and the person reading it has no way to tell.
    assert.deepEqual(asIds(["trans_1", "trans_1"]), ["trans_1"]);
  });

  test("nothing usable is an empty list, not a crash", () => {
    assert.deepEqual(asIds(undefined), []);
    assert.deepEqual(asIds([""]), []);
    assert.deepEqual(asIds(42), []);
  });

  test("a boolean sent as a string still means what it says", () => {
    assert.equal(asBool(true), true);
    assert.equal(asBool("true"), true);
    assert.equal(asBool("TRUE"), true);
    assert.equal(asBool("false"), false);
    assert.equal(asBool(undefined), false);
  });
});

describe("transaction amount filters land on the right side of zero", () => {
  /** The filters that need no lookups, against a context whose database would throw. */
  const noDb = {
    db: new Proxy({}, { get: () => assert.fail("no query should run for these filters") }),
    now: new Date("2026-07-30T00:00:00Z"),
  } as unknown as ToolContext;

  const where = async (args: Record<string, unknown>) => {
    const built = await buildWhere(args, noDb);
    assert.ok(!("error" in built), `unexpected error: ${JSON.stringify(built)}`);
    return built.where.AND as Record<string, unknown>[];
  };

  test("money out is bounded by magnitude, with the comparisons inverted", async () => {
    // The bug this exists to catch: `amount >= 50` on a spending filter matches every
    // *inflow* over fifty and nothing the person asked about. Spending is negative, so a
    // floor of 50 is `<= -50` and a ceiling of 200 is `>= -200`.
    const clauses = await where({ direction: "out", minAmount: 50, maxAmount: 200 });
    assert.deepEqual(clauses, [
      { amount: { lt: 0 } },
      { amount: { lte: -50, gte: -200 } },
      { transferGroupId: null, type: { notIn: ["TRANSFER"] } },
    ]);
  });

  test("money in keeps the comparisons as written", async () => {
    const clauses = await where({ direction: "in", minAmount: 50 });
    assert.deepEqual(clauses, [
      { amount: { gt: 0 } },
      { amount: { gte: 50 } },
      { transferGroupId: null, type: { notIn: ["TRANSFER"] } },
    ]);
  });

  test("with no direction a bound covers both sides of zero", async () => {
    // "Anything over $500" means a large refund as well as a large payment; matching
    // only the inflows would silently answer a different question.
    const clauses = await where({ minAmount: 500 });
    assert.deepEqual(clauses[0], {
      OR: [{ amount: { gte: 500 } }, { amount: { lte: -500 } }],
    });
  });

  test("a negative bound is read as the magnitude the model meant", async () => {
    // A model that has read the rows knows spending is negative and sends -50 for "at
    // least fifty spent". Taking that literally would inverse the filter.
    assert.deepEqual(await where({ direction: "out", minAmount: -50 }), [
      { amount: { lt: 0 } },
      { amount: { lte: -50 } },
      { transferGroupId: null, type: { notIn: ["TRANSFER"] } },
    ]);
  });

  test("a date names a whole day, not the instant it starts", async () => {
    // Institutions stamp most rows at midday rather than midnight, so an upper bound of
    // `2026-07-31T00:00:00` would drop everything that happened on the 31st — the day
    // the person explicitly asked to include.
    const clauses = await where({ from: "2026-07-01", to: "2026-07-31" });
    assert.deepEqual(clauses[0], { date: { gte: new Date("2026-07-01T00:00:00.000Z") } });
    assert.deepEqual(clauses[1], { date: { lte: new Date("2026-07-31T23:59:59.999Z") } });
  });

  test("a date that will not parse is reported rather than ignored", async () => {
    // Dropping it would silently widen the search to the whole history and answer
    // confidently about the wrong window.
    const built = await buildWhere({ from: "last tuesday" }, noDb);
    assert.match(String((built as { error: string }).error), /not a date/);
  });

  test("transfers are excluded unless asked for, both ways of being one", async () => {
    // Akahu tags a row's type, and a hand-linked group is the other half. A filter that
    // tested only one would let half the transfers back into a spending total.
    assert.deepEqual(await where({}), [
      { transferGroupId: null, type: { notIn: ["TRANSFER"] } },
    ]);
    assert.deepEqual(await where({ includeTransfers: true }), undefined);
  });
});

describe("repairLooseToolCall rescues how a local model encodes a call", () => {
  const set = toolsForSdk(tools, context(ALL));
  const call = (input: string, toolName = "read_thing") =>
    ({ type: "tool-call", toolCallId: "call_1", toolName, input }) as const;

  test("a markdown fence around the arguments is taken off", async () => {
    const fixed = await repairLooseToolCall({
      toolCall: call('```json\n{"area":"Food"}\n```'),
      tools: set,
    });
    assert.equal(fixed?.input, '{"area":"Food"}');
  });

  test("arguments encoded as JSON a second time are unwrapped", async () => {
    const fixed = await repairLooseToolCall({
      toolCall: call(JSON.stringify('{"area":"Food"}')),
      tools: set,
    });
    assert.equal(fixed?.input, '{"area":"Food"}');
  });

  test("arguments that were fine are left to the model to fix", async () => {
    // Valid JSON that fails the schema is not an encoding problem, and pretending to
    // repair it would hide the error the model needs to see.
    assert.equal(await repairLooseToolCall({ toolCall: call('{"area":"Food"}'), tools: set }), null);
  });

  test("nothing is repaired for a tool that does not exist", async () => {
    assert.equal(
      await repairLooseToolCall({ toolCall: call('```json\n{}\n```', "nope"), tools: set }),
      null,
    );
  });

  test("arguments beyond saving stay broken", async () => {
    assert.equal(await repairLooseToolCall({ toolCall: call("{area: Food"), tools: set }), null);
  });
});

describe("get_period_breakdown reshapes the screen's own figures", () => {
  const detail = (total: number, merchants: Record<string, number>): SpendDetail => ({
    total,
    merchants: new Map(Object.entries(merchants)),
  });

  /** Lifestyle's categories deliberately sum to 220 against a 300 area total: the
   *  remaining 80 is spending filed under the area and under no category of it. */
  const june: PeriodBreakdown = {
    key: "2026-06",
    spend: new Map([
      ["Housing", 1000],
      ["Lifestyle", 300],
    ]),
    spendDetail: new Map([
      [
        "Lifestyle",
        new Map([
          ["Cafes", detail(120, { "Corner Cafe": 90, Unknown: 30 })],
          [
            "Subscriptions",
            // Seven, to prove the tail is cut rather than sent.
            detail(100, { A: 40, B: 20, C: 15, D: 10, E: 8, F: 4, G: 3 }),
          ],
        ]),
      ],
    ]),
    incomeDetail: new Map([
      ["Wages", detail(4000, { "Example Ltd": 4000 })],
      ["Refunds", detail(50, { Unknown: 50 })],
    ]),
    incomeTotal: 4050,
    spendTotal: 1300,
    partial: false,
  };

  const july: PeriodBreakdown = {
    key: "2026-07",
    spend: new Map([["Lifestyle", 40]]),
    spendDetail: new Map(),
    incomeDetail: new Map(),
    incomeTotal: 0,
    spendTotal: 40,
    partial: true,
  };

  const comparison: Comparison = {
    period: "month",
    taxYear: DEFAULT_TAX_YEAR,
    periods: [june, july],
    spendCategories: ["Housing", "Lifestyle"],
    incomeSubcategories: ["Wages", "Refunds"],
    incomeGroups: [],
    incomeGroupOf: new Map(),
    incomeMerchants: new Map(),
    spendSubcategories: new Map(),
    spendMerchants: new Map(),
    merchantIds: new Map(),
    merchantLogos: new Map(),
    max: 4050,
    through: new Date("2026-07-14T00:00:00Z"),
    hasOlder: true,
  };

  test("each period carries its totals, ranked biggest first", () => {
    const { periods } = totalsBreakdown(comparison, "NZD");
    assert.equal(periods[0].label, "Jun 2026");
    assert.equal(periods[0].net, 2750);
    // Key order survives JSON.stringify, so the ranking is what the model reads first.
    assert.deepEqual(Object.keys(periods[0].spendByArea), ["Housing", "Lifestyle"]);
    assert.deepEqual(periods[0].incomeByCategory, { Wages: 4000, Refunds: 50 });
  });

  test("the period in progress says so, and how far its data reaches", () => {
    // A month a third synced and a month a third elapsed have identical totals.
    const shaped = totalsBreakdown(comparison, "NZD");
    assert.equal(shaped.through, "2026-07-14");
    assert.equal(shaped.periods[0].partial, undefined);
    assert.equal(shaped.periods[1].partial, true);
  });

  test("an area's parts are made to sum to its whole", () => {
    const shaped = areaBreakdown(comparison, "NZD", "Lifestyle") as {
      periods: { total: number; uncategorised?: number; categories: { category: string }[] }[];
    };
    const [first] = shaped.periods;
    assert.equal(first.total, 300);
    // Without this the categories quietly total 220 and nothing says why.
    assert.equal(first.uncategorised, 80);
    assert.deepEqual(
      first.categories.map((c) => c.category),
      ["Cafes", "Subscriptions"],
    );
  });

  test("only the payees worth naming are sent", () => {
    const shaped = areaBreakdown(comparison, "NZD", "lifestyle") as {
      periods: { categories: { merchants: Record<string, number> }[] }[];
    };
    const subscriptions = shaped.periods[0].categories[1].merchants;
    assert.deepEqual(Object.keys(subscriptions), ["A", "B", "C", "D", "E"]);
  });

  test("an area that does not exist is answered with the ones that do", () => {
    // The house rule: an error the model can act on, not an exception.
    const shaped = areaBreakdown(comparison, "NZD", "Lifestyel") as {
      error: string;
      areas: string[];
    };
    assert.match(shaped.error, /No spending area called "Lifestyel"/);
    assert.deepEqual(shaped.areas, ["Housing", "Lifestyle"]);
  });

  test("a period it cannot bucket by is refused before it reads anything", async () => {
    // The stub context has no database, so reaching one would throw rather than answer.
    const execute = toolsForSdk([getPeriodBreakdown], context(ALL)).get_period_breakdown?.execute;
    assert.ok(execute);
    const options = { toolCallId: "call_1", messages: [] } as never;
    const result = (await execute({ period: "fortnight" }, options)) as {
      error: string;
      periods: string[];
    };
    assert.match(result.error, /not a period/);
    assert.ok(result.periods.includes("month"));
  });
});

describe("elisionsFor drops the oldest tool output first", () => {
  const toolRow = (id: string, seq: number, size: number): StoredMessage => ({
    id,
    seq,
    role: "tool",
    content: "x".repeat(size),
    toolCalls: null,
    toolCallId: `call_${id}`,
    toolName: "get_transactions",
    elided: false,
  });

  test("everything inside the budget survives", () => {
    assert.deepEqual(elisionsFor([toolRow("a", 0, 100), toolRow("b", 1, 100)]), []);
  });

  test("past the budget, the oldest go", () => {
    // The default budget is 60_000 characters, so three 40k pages cannot all stay.
    const rows = [toolRow("a", 0, 40_000), toolRow("b", 1, 40_000), toolRow("c", 2, 40_000)];
    // Newest first: "c" fits, "b" does not, "a" does not.
    assert.deepEqual(elisionsFor(rows).sort(), ["a", "b"]);
  });

  test("a row already elided is not counted or re-elided", () => {
    const rows = [{ ...toolRow("a", 0, 90_000), elided: true }, toolRow("b", 1, 100)];
    assert.deepEqual(elisionsFor(rows), []);
  });

  test("non-tool messages are never elided, however long", () => {
    const essay: StoredMessage = {
      id: "essay",
      seq: 0,
      role: "assistant",
      content: "x".repeat(200_000),
      toolCalls: null,
      toolCallId: null,
      toolName: null,
      elided: false,
    };
    assert.deepEqual(elisionsFor([essay]), []);
  });
});

describe("toModelMessages rebuilds a thread the endpoint will accept", () => {
  const thread: StoredMessage[] = [
    {
      id: "m1",
      seq: 0,
      role: "user",
      content: "what did I spend on food?",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
      elided: false,
    },
    {
      id: "m2",
      seq: 1,
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "call_1", type: "function", function: { name: "get_transactions", arguments: '{"area":"Food"}' } },
      ],
      toolCallId: null,
      toolName: null,
      elided: false,
    },
    {
      id: "m3",
      seq: 2,
      role: "tool",
      content: '{"matched":12}',
      toolCalls: null,
      toolCallId: "call_1",
      toolName: "get_transactions",
      elided: false,
    },
  ];

  /** The one tool-result part of a rebuilt tool message. */
  const resultPart = (message: ModelMessage) => {
    assert.equal(message.role, "tool");
    const [part] = (message as ToolModelMessage).content;
    assert.equal(part.type, "tool-result");
    return part as Extract<typeof part, { type: "tool-result" }>;
  };

  test("a tool call and its result survive as a pair", () => {
    const messages = toModelMessages(thread);
    assert.equal(messages.length, 3);
    const assistant = messages[1] as AssistantModelMessage;
    const call = (assistant.content as { type: string; toolCallId?: string }[])[0];
    assert.equal(call.type, "tool-call");
    assert.equal(call.toolCallId, "call_1");
    const part = resultPart(messages[2]);
    assert.equal(part.toolCallId, "call_1");
    assert.deepEqual(part.output, { type: "json", value: { matched: 12 } });
  });

  test("an elided result keeps its place and its id, and loses only its content", () => {
    // This is the property that matters: dropping the *message* would orphan the call
    // above it and the endpoint would reject the whole conversation.
    const messages = toModelMessages(thread, new Set(["m3"]));
    assert.equal(messages.length, 3);
    const part = resultPart(messages[2]);
    assert.equal(part.toolCallId, "call_1");
    assert.match(JSON.stringify(part.output), /dropped to save room/);
    assert.doesNotMatch(JSON.stringify(part.output), /matched/);
  });

  test("`elided` stored on the row counts the same as being named", () => {
    const stored = thread.map((m) => (m.id === "m3" ? { ...m, elided: true } : m));
    const part = resultPart(toModelMessages(stored)[2]);
    assert.match(JSON.stringify(part.output), /dropped to save room/);
  });

  test("an assistant turn with no tool calls carries none", () => {
    const plain: StoredMessage = { ...thread[1], toolCalls: null, content: "about $400." };
    const message = toModelMessages([plain])[0] as AssistantModelMessage;
    assert.deepEqual(message.content, [{ type: "text", text: "about $400." }]);
  });
});

describe("titleFrom names a thread from what was asked", () => {
  test("the first line", () => {
    assert.equal(titleFrom("What did I spend?\nAnd on what?"), "What did I spend?");
  });

  test("a long one is cut, not wrapped", () => {
    const title = titleFrom("x".repeat(200));
    assert.equal(title.length, 70);
    assert.ok(title.endsWith("…"));
  });

  test("nothing typed still names it something", () => {
    assert.equal(titleFrom("   "), "New chat");
  });
});

describe("parseCommand tells a command from a thing someone said", () => {
  test("a command with no argument", () => {
    assert.equal(parseCommand("/stop")?.command.name, "stop");
    assert.equal(parseCommand("/stop")?.rest, "");
  });

  test("the argument keeps its own spacing, and the name is not case-sensitive", () => {
    const parsed = parseCommand("/Steer  look at Food  instead ");
    assert.equal(parsed?.command.name, "steer");
    assert.equal(parsed?.rest, "look at Food  instead");
  });

  test("a slash word that is not a command is an ordinary message", () => {
    // The property that matters. Someone pasting a path into a conversation about their
    // money must not have it swallowed as a typo'd command, or refused.
    assert.equal(parseCommand("/Users/someone/statements/june.csv"), null);
    assert.equal(parseCommand("/stpo"), null);
    assert.equal(parseCommand("/"), null);
  });

  test("a message that merely mentions a slash is not a command", () => {
    assert.equal(parseCommand("what does /stop do?"), null);
  });

  test("the menu offers only what applies right now, and only while the name is typed", () => {
    const idle = commandMenu("/", "idle")?.map((c) => c.name);
    assert.ok(idle?.includes("compact"), "compact is a between-turns thing");
    assert.ok(!idle?.includes("stop"), "there is nothing to stop between turns");

    const running = commandMenu("/s", "running")?.map((c) => c.name);
    assert.deepEqual(running, ["stop", "steer"]);

    // The composer on /chat, where there is no thread yet: nothing to stop, redirect or
    // summarise, and the one decision that is worth making before the first question.
    const fresh = commandMenu("/", "new")?.map((c) => c.name);
    assert.deepEqual(fresh, ["model", "help"]);

    // Past the first word the argument has started and the menu is in the way.
    assert.equal(commandMenu("/steer look at Food", "running"), null);
    assert.equal(commandMenu("what did I spend", "idle"), null);
  });
});

describe("toModelMessages will not send a result whose call was cut away", () => {
  // Compaction starts a conversation part-way through itself, and the messages before
  // the cut are simply not fetched. That makes a stranded tool result possible for the
  // first time — and the endpoint's answer to one is to refuse the whole request, on the
  // *next* turn, in a thread that has been working for a week.
  const call: StoredMessage = {
    id: "m2",
    seq: 1,
    role: "assistant",
    content: null,
    toolCalls: [
      { id: "call_1", type: "function", function: { name: "get_transactions", arguments: "{}" } },
    ],
    toolCallId: null,
    toolName: null,
    elided: false,
  };
  const result: StoredMessage = {
    id: "m3",
    seq: 2,
    role: "tool",
    content: '{"matched":12}',
    toolCalls: null,
    toolCallId: "call_1",
    toolName: "get_transactions",
    elided: false,
  };

  test("the pair survives when both are in the window", () => {
    const messages = toModelMessages([call, result]);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].role, "tool");
  });

  test("the result alone is dropped", () => {
    assert.deepEqual(toModelMessages([result]), []);
  });

  test("an assistant message that said nothing and called nothing is not sent empty", () => {
    const silent: StoredMessage = { ...call, toolCalls: null };
    assert.deepEqual(toModelMessages([silent]), []);
  });

  test("a stored system row is dropped, not turned into a system message", () => {
    // The SDK refuses a system message found among the others; the prompt travels as
    // `instructions`. A row from an older version of this code must not resurrect one.
    const stale: StoredMessage = { ...call, role: "system", content: "you are a bot", toolCalls: null };
    assert.deepEqual(toModelMessages([stale]), []);
  });
});

describe("compactionCut leaves a conversation that can be continued", () => {
  const row = (seq: number, role: string, toolCalls: unknown = null): StoredMessage => ({
    id: `m${seq}`,
    seq,
    role,
    content: "…",
    toolCalls,
    toolCallId: role === "tool" ? "call_1" : null,
    toolName: role === "tool" ? "get_transactions" : null,
    elided: false,
  });
  const calls = [{ id: "call_1", type: "function", function: { name: "get_transactions", arguments: "{}" } }];

  test("a short conversation is not worth compacting", () => {
    const rows = [row(0, "user"), row(1, "assistant")];
    assert.equal(compactionCut(rows), null);
  });

  test("the cut lands on a completed exchange, never between a call and its result", () => {
    // seq 4 is the assistant asking for a tool and seq 5 is the answer: cutting at 4
    // would send 5 on its own next turn.
    const rows = [
      row(0, "user"),
      row(1, "assistant"),
      row(2, "user"),
      row(3, "assistant"),
      row(4, "assistant", calls),
      row(5, "tool"),
      row(6, "assistant"),
      row(7, "user"),
    ];
    assert.equal(compactionCut(rows, -1, 2), 3);
  });

  test("the tail is left alone", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i, i % 2 === 0 ? "user" : "assistant"));
    const cut = compactionCut(rows, -1, 6);
    assert.ok(cut !== null && cut <= 5, `cut at ${cut} ate into the last six messages`);
  });

  test("compacting twice starts where the first one stopped", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i, i % 2 === 0 ? "user" : "assistant"));
    const first = compactionCut(rows, -1, 6);
    assert.ok(first !== null);
    const second = compactionCut(rows, first, 6);
    assert.ok(second === null || second > first, "a second cut must move forward");
  });

  test("nothing new since the last compaction is nothing to do", () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(i, i % 2 === 0 ? "user" : "assistant"));
    assert.equal(compactionCut(rows, 7), null);
  });
});
