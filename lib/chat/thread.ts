import type { JSONValue, ModelMessage } from "ai";

import { readToolCalls } from "./messages";

// Turning stored rows back into a conversation, with no database in sight.
//
// The same split as lib/budget/llm.ts and its server half: this is the part where a
// bug is silent — a tool result quietly orphaned from its call, a context budget that
// drops the wrong thing — so it is the part the tests can reach. The writes live in
// lib/server/chat/thread.ts.

/**
 * How much tool output, in characters, the model is allowed to still be carrying.
 *
 * A single `get_transactions` page can be a hundred kilobytes of JSON. Three of them
 * and a small local model has nothing left to think with, which is exactly the wall
 * the headless budget inference hit and solved in-flight by dropping an area's rows
 * once it had proposed for that area. A chat cannot use that rule — there are no areas
 * being closed off — so it uses the underlying one instead: keep the newest tool output
 * up to a budget, and drop what is older than that.
 *
 * The row itself is never modified; `elided` only says what the *model* is shown. The
 * person can still scroll back and read every row the model read, which matters — the
 * whole argument for a chat over a headless run is that you can see its working.
 */
export const CONTEXT_TOOL_BUDGET = Number(process.env.LLM_CONTEXT_TOOL_BUDGET ?? 60_000);

/** A stored message, as this module needs it. */
export type StoredMessage = {
  id: string;
  seq: number;
  role: string;
  content: string | null;
  toolCalls: unknown;
  toolCallId: string | null;
  toolName: string | null;
  elided: boolean;
};

/**
 * Decide which tool results the model still gets to see, newest first.
 *
 * Returns the ids that should be elided, so the caller can persist the decision in the
 * same pass it rebuilds the conversation — the alternative, recomputing it per turn
 * from a budget that may have changed, would have the model watch results it had
 * already reasoned over flicker back into existence.
 */
export function elisionsFor(
  messages: StoredMessage[],
  budgetChars: number = CONTEXT_TOOL_BUDGET,
): string[] {
  let budget = budgetChars;
  const elide: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "tool") continue;
    if (message.elided) continue;
    const size = message.content?.length ?? 0;
    if (size <= budget) budget -= size;
    else elide.push(message.id);
  }
  return elide;
}

/** The placeholder an elided tool result is shown to the model as. Says what it was
 *  and that it is gone, so a model looking for it asks again rather than assuming the
 *  answer was empty. */
export const elidedContent = (toolName: string | null) =>
  JSON.stringify({
    elided: `The result of ${toolName ?? "this tool call"} has been dropped to save room. Call it again if you still need it.`,
  });

/**
 * A stored thread as the messages to send.
 *
 * Tool results are paired with their calls by `tool_call_id`, and the API rejects a
 * result whose call it cannot see — so an elided message keeps its place and its id
 * and loses only its content. Same trade the inference makes in-flight, for the same
 * reason.
 */
export function toModelMessages(
  messages: StoredMessage[],
  elided: ReadonlySet<string> = new Set(),
): ModelMessage[] {
  const out: ModelMessage[] = [];
  // Which calls are actually in this window. A compacted thread starts part-way through
  // itself, and the cut can fall between an assistant asking for a tool and the row
  // answering it — at which point the answer refers to a call the model cannot see, and
  // the request is refused outright. Tracked rather than assumed: the tool result always
  // follows its call, so a call not seen by now is one that was cut away.
  const calls = new Set<string>();

  for (const message of messages) {
    const isElided = message.elided || elided.has(message.id);

    switch (message.role) {
      case "system":
        // Dropped, not carried. The system prompt is never stored — it is rebuilt per
        // turn and passed as `instructions` — and the SDK rejects a whole request that
        // has a system message among the others, so a stray row must not become one.
        break;

      case "user":
        out.push({ role: "user", content: message.content ?? "" });
        break;

      case "assistant": {
        // A content *array* rather than a string, because an assistant turn is one
        // message whether it spoke, called tools, or did both — and the two have to
        // travel together or the tool results that follow have nothing to attach to.
        const content: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
        if (message.content) content.push({ type: "text", text: message.content });
        for (const call of readToolCalls(message.toolCalls)) {
          calls.add(call.id);
          content.push({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.name,
            input: parseInput(call.arguments),
          });
        }
        if (content.length > 0) out.push({ role: "assistant", content });
        break;
      }

      case "tool":
        // A tool result with no call to answer would be rejected outright; drop it
        // rather than send a conversation the endpoint will refuse.
        if (!message.toolCallId || !calls.has(message.toolCallId)) break;
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: message.toolName ?? "",
              output: {
                type: "json",
                value: parseInput(
                  isElided ? elidedContent(message.toolName) : (message.content ?? "null"),
                ),
              },
            },
          ],
        });
        break;
    }
  }

  return out;
}

/** Stored JSON back to a value. Tool arguments are kept as the model sent them —
 *  verbatim, which includes verbatim broken — so anything unreadable becomes an empty
 *  object rather than throwing on a thread that has been fine for a week. */
function parseInput(raw: string | null): JSONValue {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as JSONValue;
  } catch {
    return {};
  }
}
