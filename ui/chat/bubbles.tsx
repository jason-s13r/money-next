import type { ChatMessageView } from "@/lib/chat/messages";
import { parseToolResult } from "@/lib/chat/messages";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { Thinking } from "./thinking";
import { ToolCard } from "./tool-card";

// What a conversation looks like, once it is only being read.
//
// Split out of ui/chat/conversation.tsx, which owns the live half — the stream, the
// composer, the turn in flight — because there are now two things that show a
// conversation and only one of them is happening. The other is the log of an unattended
// budget inference (`ChatThread.unattended`), which is finished, or being written by a
// worker in another process, and either way is nobody's turn to take.
//
// No `"use client"`: the log page renders these on the server, from rows, with no state
// at all. The chat imports them into a client component, where they compile as client
// code as they always did. `ToolCard` and `Thinking` bring their own directive, being
// the pieces with something to click.

/** One thing on the screen. A `tool` bubble is a call and its answer together, which is
 *  why the stream can fill the answer in after the call has been drawn — and a
 *  `thinking` bubble is one stretch of reasoning, appended to in the same way until the
 *  model does something else. */
export type Bubble =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "tool"; key: string; callId: string; name: string; args: string; result?: unknown }
  | { kind: "thinking"; key: string; text: string; live: boolean }
  | { kind: "notice"; key: string; text: string }
  | { kind: "error"; key: string; text: string };

export function BubbleView({ bubble }: { bubble: Bubble }) {
  switch (bubble.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          {/* Not `secondary`, for the reason ui/transactions/labels-cell.tsx ran into: this
              theme remaps `--color-secondary` to a dark *text* colour, so
              `bg-secondary text-secondary-foreground` painted a dark pill and then put
              near-black text on it — 2.26:1 in light, 1.72:1 in dark, both below AA.
              `accent` is what shadcn's secondary was meant to be here, but at oklch(0.97) it
              is 1.09:1 against the page and stops reading as a bubble at all. `primary` is
              correctly paired in both modes and keeps the filled pill this always looked
              like — measured in the browser at 17.2:1 light and 14.2:1 dark. */}
          <div
            className={cn(
              "max-w-[85%] rounded-2xl bg-primary px-3 py-2",
              "text-sm whitespace-pre-wrap text-primary-foreground",
            )}
          >
            {bubble.text}
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className="px-1">
          <Markdown>{bubble.text}</Markdown>
        </div>
      );

    case "tool":
      return <ToolCard name={bubble.name} args={bubble.args} result={bubble.result} />;

    // Only ever produced by the live stream — `toBubbles` cannot make one, because
    // reasoning is not stored. The read-only log of an unattended run has none.
    case "thinking":
      return <Thinking text={bubble.text} live={bubble.live} />;

    case "notice":
      // A one-liner ("Stopped.") is an aside about the conversation; a listing (`/help`,
      // `/model`, or an inference log's own notes) is a table, and lines up only in a
      // monospace font.
      return (
        <p
          className={cn(
            "px-1 whitespace-pre-wrap text-muted-foreground",
            bubble.text.includes("\n") ? "font-mono text-xs" : "text-sm italic",
          )}
        >
          {bubble.text}
        </p>
      );

    case "error":
      return (
        <p
          role="alert"
          className={cn(
            "rounded-lg border border-status-critical/30 bg-status-critical/5 px-3 py-2 text-sm",
            "text-status-critical",
          )}
        >
          {bubble.text}
        </p>
      );
  }
}

/** Stored messages as bubbles. Tool results are matched back to the call that asked
 *  for them by `tool_call_id`, which is why both are stored. */
export function toBubbles(messages: ChatMessageView[]): Bubble[] {
  const results = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      results.set(message.toolCallId, parseToolResult(message.content));
    }
  }

  const bubbles: Bubble[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      bubbles.push({ key: message.id, kind: "user", text: message.content ?? "" });
    } else if (message.role === "assistant") {
      if (message.content?.trim()) {
        bubbles.push({ key: message.id, kind: "assistant", text: message.content });
      }
      for (const call of message.toolCalls) {
        bubbles.push({
          key: `${message.id}:${call.id}`,
          kind: "tool",
          callId: call.id,
          name: call.name,
          args: call.arguments,
          result: results.get(call.id) ?? null,
        });
      }
    } else if (message.role === "system" && message.content?.trim()) {
      // A chat never stores one. An inference log does: its `system` rows are the run
      // talking about itself — which model, how many areas, what it fell back to — and
      // they are shown as the asides they are, not as anything anyone said.
      bubbles.push({ key: message.id, kind: "notice", text: message.content });
    }
    // A `tool` row is rendered by the call it answers.
  }
  return bubbles;
}
