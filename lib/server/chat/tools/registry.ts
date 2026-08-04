// No `import "server-only"`: the registry is consumed by the worker's budget
// inference as well as by a chat turn in a request.
import { jsonSchema, tool as defineTool, type ToolSet } from "ai";

import { parseToolArguments, type Catalog } from "../../../budget/llm";
import type { DisplayFx } from "../../budget/fx";
import type { ScopedDb } from "../../db";
import type { History } from "./history";

// What a model can see and do, as data. The budget inference and the interactive
// chat are the same loop over different tool sets, so a tool is a plain object
// defined once. MCP-shaped, but not MCP: handlers run under the caller's
// `scopedDb`, and crossing a wire would mean rebuilding that on the far side.

/**
 * The kinds of change a tool can make, which are the permissions gating them.
 * `enrichment` is deliberately separate from `budget`: a bookkeeper who may
 * recategorise need not be able to rewrite the household's plan.
 */
export type WriteScope = "budget" | "enrichment";

/** Which of those the caller holds. */
export type Permissions = Record<WriteScope, boolean>;

/** What each scope is called when a model is told it may not do it. */
const SCOPE_REFUSAL: Record<WriteScope, string> = {
  budget: "You do not have permission to change budgets in this workspace.",
  enrichment:
    "You do not have permission to change transactions, rules or labels in this workspace.",
};

/**
 * Everything a handler is allowed to reach. No ambient request and no ambient
 * database: the scoped client is passed in, already bound to one workspace by
 * whoever authenticated the caller.
 */
export type ToolContext = {
  /** Already workspace-scoped. A handler never widens this and never needs to. */
  db: ScopedDb;
  now: Date;
  /** The workspace's display currency; every amount in and out is in it. */
  currency: string;
  /** Converts an account's amount into that currency. Lazy: most turns never need it. */
  fx: () => Promise<DisplayFx>;
  /** Name→id lookups, so a model that only ever says names cannot name a row. */
  catalog: Catalog;
  /** The transaction window. Lazy in a chat, already loaded in an inference. */
  history: () => Promise<History>;
  /** Which kinds of change the caller may make. Gates every `write` tool. */
  can: Permissions;
  /** Who is asking, for the field change log — null when nobody is (the worker).
   *  Captured at turn start, not at the write: a turn outlives the request that
   *  started it, so by then there is no session to resolve. */
  actorUserId: string | null;
};

/** The call itself, for the rare handler that needs to know which one it is answering.
 *  The budget inference keys its in-flight elision on the id. */
export type ToolMeta = { toolCallId: string };

export type Tool = {
  name: string;
  description: string;
  /** JSON schema for the arguments, written by hand — the models this talks to are
   *  small, and a schema tuned for them beats a generated one. */
  parameters: Record<string, unknown>;
  /** What this tool changes, when it changes anything. Offered only to a caller
   *  holding the matching permission, and refused by `runTool` regardless of what
   *  was offered. */
  write?: WriteScope;
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext,
    meta: ToolMeta,
  ) => Promise<unknown> | unknown;
};

/** The tools this caller may use: read tools always, a write tool only when the
 *  scope it writes in is one the caller holds. */
export function availableTools(tools: Tool[], can: Permissions): Tool[] {
  return tools.filter((tool) => !tool.write || can[tool.write]);
}

/**
 * The same tools, as the AI SDK wants them, handlers bound to a context. Schemas
 * pass through `jsonSchema()` verbatim rather than being regenerated from Zod:
 * they are hand-tuned for small models, and a rewrite would retune every tool.
 */
export function toolsForSdk(tools: Tool[], ctx: ToolContext): ToolSet {
  const set: ToolSet = {};
  for (const tool of tools) {
    set[tool.name] = defineTool({
      description: tool.description,
      inputSchema: jsonSchema<Record<string, unknown>>(tool.parameters as never),
      execute: (args, { toolCallId }) => runTool(tool, args, ctx, { toolCallId }),
    });
  }
  return set;
}

/**
 * Rescue a tool call whose arguments a small model mangled on the way out — a
 * markdown fence around the object, a string JSON-encoded twice. Null for
 * anything else, which hands the model an error only it can fix.
 */
export function repairLooseToolCall({
  toolCall,
  tools,
}: {
  toolCall: { type: "tool-call"; toolCallId: string; toolName: string; input: string };
  tools: ToolSet;
}): Promise<{ type: "tool-call"; toolCallId: string; toolName: string; input: string } | null> {
  if (!Object.hasOwn(tools, toolCall.toolName)) return Promise.resolve(null);

  const args = parseToolArguments(toolCall.input);
  if (args === null) return Promise.resolve(null);

  const input = JSON.stringify(args);
  // Unchanged means the encoding was never the problem — the schema was.
  if (input === toolCall.input.trim()) return Promise.resolve(null);
  return Promise.resolve({ ...toolCall, input });
}

/**
 * Run one tool's handler, turning every way it can go wrong into a value: a
 * throw would end a run the model was one correction away from getting right.
 * Permission is re-checked here — naming an unoffered tool must be refused.
 */
async function runTool(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: ToolContext,
  meta: ToolMeta,
): Promise<unknown> {
  if (tool.write && !ctx.can[tool.write]) {
    return { error: SCOPE_REFUSAL[tool.write] };
  }
  try {
    return await tool.handler(args, ctx, meta);
  } catch (error) {
    // Not passed through verbatim: it may be a Prisma error naming columns and ids the
    // model has no business seeing.
    console.error(`  [tool] ${tool.name} threw:`, error);
    return { error: `${tool.name} failed. Try a different approach.` };
  }
}

// --- Argument coercion. -----------------------------------------------------
//
// Models send numbers as strings, dates with a time on the end, and strings with
// stray whitespace. These are the readings that survive all of that.

/** A trimmed non-empty string, or "". */
export function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A `YYYY-MM-DD` from a tool argument, or null — dates are compared as strings,
 *  which the ISO day format makes safe. */
export function asDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value.trim());
  return match ? match[0] : null;
}

/**
 * A `YYYY-MM-DD` as UTC midnight, or null — the representation the recurrence module
 * uses for an NZ calendar day throughout (NZ leads UTC, so UTC midnight always
 * resolves back to the same NZ day). Same parse as the budget form's `parseDay`,
 * including its rejection of 31 February, which `Date.UTC` would roll over in silence.
 */
export function asDate(value: unknown): Date | null {
  const day = asDay(value);
  if (!day) return null;
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

/** A whole number from a tool argument, or null. */
export function asInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** A number from a tool argument, or null. Unrounded, for amounts. */
export function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A list of ids from a tool argument. Tolerates the single string a model sends
 *  when it has one id and forgot the brackets, and the comma-separated string it
 *  sends when it has several. Duplicates dropped so a list naming the same row
 *  twice cannot inflate a tool's "rows touched" count. */
export function asIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(raw.map((item) => asText(item)).filter((item) => item !== ""))];
}

/** A boolean from a tool argument. Models send `"true"` as often as `true`. */
export function asBool(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

/** The distinct non-null values, order-stable. */
export function distinct(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) if (value) seen.add(value);
  return [...seen];
}

/** The `limit` commonest values of a field, biggest first. */
export function topBy<T>(rows: T[], pick: (row: T) => string | null, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = pick(row);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value]) => value);
}
