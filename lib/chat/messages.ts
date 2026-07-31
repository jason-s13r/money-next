// The pure half of the chat: the shapes a thread takes on the way to a screen, and
// the small amount of reasoning about them that both halves need. No database, no
// network, no `openai` import — this module is reachable from a client component, so
// anything it pulls in ships to the browser.
//
// Rehydrating a thread back into what the API wants is *not* here, deliberately: that
// needs the `openai` message types and belongs to the server. See
// lib/server/chat/thread.ts.

/** A thread as the list and the header show it. */
export type ChatThreadView = {
  id: string;
  title: string;
  /** Epoch millis — `Date` does not survive the RSC boundary. */
  updatedAt: number;
  /** A turn is in flight. The page attaches to it rather than starting another. */
  running: boolean;
  messages: number;
  /** The log of a background run rather than a conversation anyone is having — see
   *  `ChatThread.unattended`. Read-only: no composer, and nothing to attach to. */
  unattended?: boolean;
  /** This *was* one, and somebody took it over (`ChatThread.continuedAt`). An ordinary
   *  conversation in every way that matters; the header says where it came from,
   *  because the hundred messages above the takeover were nobody's. */
  continued?: boolean;
  /** The model chosen for this thread, or null for whatever the server's default is. */
  model?: string | null;
  /** How many messages the model no longer sees directly, because they have been
   *  summarised. Zero for a conversation that has not been compacted. */
  compacted?: number;
};

/** One tool call an assistant turn asked for. `arguments` stays a string because that
 *  is what the model produced, and a chat that shows what was asked should show what
 *  was actually asked — parsing is the renderer's business. */
export type ToolCallView = { id: string; name: string; arguments: string };

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessageView = {
  id: string;
  seq: number;
  role: ChatRole;
  content: string | null;
  toolCalls: ToolCallView[];
  toolCallId: string | null;
  toolName: string | null;
};

/** A stored row as the UI sees it. `toolCalls` is `Json` in the database and `unknown`
 *  by the time it gets here, so it is re-read defensively rather than cast: a row
 *  written by an older version of this code must not throw a page. */
export function toMessageView(row: {
  id: string;
  seq: number;
  role: string;
  content: string | null;
  toolCalls: unknown;
  toolCallId: string | null;
  toolName: string | null;
}): ChatMessageView {
  return {
    id: row.id,
    seq: row.seq,
    role: isRole(row.role) ? row.role : "assistant",
    content: row.content,
    toolCalls: readToolCalls(row.toolCalls),
    toolCallId: row.toolCallId,
    toolName: row.toolName,
  };
}

function isRole(value: string): value is ChatRole {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

export function readToolCalls(value: unknown): ToolCallView[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCallView[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const call = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = call.function?.name;
    if (typeof name !== "string") continue;
    calls.push({
      id: typeof call.id === "string" ? call.id : name,
      name,
      arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "{}",
    });
  }
  return calls;
}

/** A tool result's stored content, parsed. Returns null rather than throwing: the
 *  content is whatever `JSON.stringify` produced at the time, and a renderer that
 *  cannot read it should fall back to showing the raw text, not crash the thread. */
export function parseToolResult(content: string | null): unknown {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * A thread's title, from the message that opened it.
 *
 * The model is not asked to summarise: that would be a whole round trip standing
 * between pressing send and seeing anything, to name something the user just typed
 * and can rename.
 */
export function titleFrom(message: string): string {
  const line = message.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "New chat";
  return line.length > 70 ? `${line.slice(0, 69).trimEnd()}…` : line;
}

/** The prompt the "Infer a budget with AI" button opens a thread with. Exported so
 *  the button and any test agree on one wording. */
export const BUDGET_PROMPT =
  "Help me build a budget from my transaction history. Start by looking at what I spend on, " +
  "then work through it with me area by area — tell me what you find and what you would " +
  "budget for it, and ask me before you create anything.";
