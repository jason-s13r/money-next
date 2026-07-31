// No `import "server-only"`: the registry is consumed by the worker's budget
// inference as well as by a chat turn in a request.
import { jsonSchema, tool as defineTool, type ToolSet } from "ai";

import { parseToolArguments, type Catalog } from "../../../budget/llm";
import type { DisplayFx } from "../../budget/fx";
import type { ScopedDb } from "../../db";
import type { History } from "./history";

// What a model can see and do, as data.
//
// Both conversations in this app — the headless budget inference and the interactive
// chat — are the same loop over a different set of tools, so a tool is defined once,
// here, as a plain object rather than a branch of a switch. `toolsForSdk` turns a set of
// them into what the AI SDK wants, handlers bound to a context, and is the single place
// the house rules about tool failure are enforced.
//
// The shape is deliberately the shape an MCP server would want (name, description,
// JSON-schema parameters, handler), so exposing this registry to an external client
// later is a transport, not a rewrite. It is *not* MCP today, and that is the point:
// every handler is a Prisma call that has to run under the caller's own
// `scopedDb(workspaceId)` with RLS beneath it, and the validation gate
// (`resolveProposedItems`) is in this process. Crossing a wire would mean rebuilding
// both on the far side.

/**
 * The kinds of change a tool can make, which are the workspace permissions that gate
 * them (see lib/server/auth/roles.ts). One flag was enough while every write tool
 * touched a budget; the enrichment tools — categorising a transaction, naming its
 * payee, writing a rule — are gated on `enrichment: ["update"]`, which is a
 * deliberately separate grant. A bookkeeper who may recategorise need not be able to
 * rewrite the household's plan, and the tools must not be the place that collapses
 * the distinction the roles draw.
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
 * Everything a handler is allowed to reach. There is no ambient request and no
 * ambient database: the scoped client is passed in, already bound to one workspace by
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
  /**
   * Who is asking, for the field change log — null when nobody is (the worker).
   *
   * Passed in rather than read at the write, which is the opposite of what
   * `recordUserChanges` does and for a specific reason: a chat turn is detached from
   * the request that started it (see lib/server/chat/runs.ts), so by the time a tool
   * writes there is no request left to resolve a session from. It is captured while
   * there still is one.
   */
  actorUserId: string | null;
};

/** The call itself, for the rare handler that needs to know which one it is answering.
 *  The budget inference keys its in-flight elision on the id, so it can find a served
 *  page again in the conversation once the area it belonged to is finished with. */
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
 *  scope it writes in is one the caller holds. A viewer is never *offered* a tool it
 *  would be refused; an editor granted one scope and not the other is offered
 *  exactly the half they can use. */
export function availableTools(tools: Tool[], can: Permissions): Tool[] {
  return tools.filter((tool) => !tool.write || can[tool.write]);
}

/**
 * The same tools, as the AI SDK wants them: a set keyed by name, each with its handler
 * already bound to the context it will run against.
 *
 * **The schemas are passed through, not regenerated.** `jsonSchema()` takes what is
 * written in the tool file verbatim, which is the whole reason it is used here in
 * preference to the Zod schemas the SDK's examples reach for. The note on `Tool.parameters`
 * is not decoration — these schemas are hand-tuned for models small enough to be
 * confused by a faithful one, and a Zod rewrite would quietly retune every tool in the
 * app by regenerating them.
 *
 * The house rule about failure survives too: `execute` returns errors rather than
 * throwing, so a handler that fails reaches the model as something it can read and
 * correct on its next step. Schema-invalid calls are the SDK's to report, and it does
 * the same thing with them.
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
 * Rescue a tool call whose arguments a small local model mangled on the way out.
 *
 * The SDK's own parse is strict, and rightly: arguments that are not JSON are not
 * arguments. But the failures seen here are not the model being wrong about *what* to
 * call — they are it wrapping the object in a markdown fence, or JSON-encoding the
 * string a second time, both of which are recoverable without asking it anything.
 * `parseToolArguments` is where that tolerance lives, and this is what still reaches it
 * now that the SDK owns the parsing.
 *
 * Null for everything else, which hands the model the error instead: a name that is not
 * a tool, or arguments that parse fine and simply do not match the schema, are things
 * only the model can fix.
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
 * Run one tool's handler, turning every way it can go wrong into a value.
 *
 * **Failure is a value, never an exception.** This is the load-bearing rule of the whole
 * design: a model that tripped over a handler is told so *in the conversation*, on its
 * next turn, where it can fix it. Throwing would end a run over something the model was
 * one correction away from getting right. Schema-invalid calls are the SDK's to report,
 * and it does the same thing with them.
 *
 * The permission check is here rather than only at `availableTools` because being
 * offered a tool and being allowed to run it are different questions, and the second
 * one is the one that matters — a model that names a write tool it was never offered
 * must be refused, not obeyed.
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

/**
 * A list of ids from a tool argument.
 *
 * Tolerates the single string a model sends when it has one id and forgot the
 * brackets, and the comma-separated string it sends when it has several and forgot
 * them harder. Duplicates are dropped: every tool that takes ids reports how many
 * rows it touched, and a list naming the same row twice would inflate that.
 */
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
