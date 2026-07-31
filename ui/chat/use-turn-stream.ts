"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { toBubbles, type Bubble } from "./bubbles";
import type { ChatMessageView } from "@/lib/chat/messages";

// Watching a turn: the connection to the turn route, and the bubbles it produces.
//
// Split out of ./conversation.tsx, which was holding this *and* the slash commands
// *and* the model picker *and* the layout. The seam is a real one rather than a
// line count: everything here is about a stream — its wire format, how far the
// page has read it, what it does to what is on screen — and the component around
// it never touches any of that, only the bubbles that come out and whether a turn
// is in flight. What is left there reads as a chat UI; what is here reads as a
// protocol, and each can be understood without the other.
//
// It reads a stream of newline-delimited JSON. Not an `EventSource`: that can only
// issue a GET, and the message has to go up in a body. Not a WebSocket either —
// the client→server direction is one message per turn, which is a plain POST, and
// duplex would cost a custom server for nothing.
//
// **Watching a turn is not the same as running one.** The turn belongs to the
// thread, server-side, so this only ever subscribes to it: on arrival it asks to
// watch whatever is in flight (`attach`), and closing the tab stops the watching
// and nothing else. Stop is a separate statement — a server action — because it
// means something different from looking away.
//
// **Where the client has got to is a seq, not a guess.** Every request carries
// `since`, the highest message the page has actually rendered, and the server
// replays only what came after it. That is what lets a reload mid-turn continue
// the same answer instead of showing it twice or missing its beginning.

type Options = {
  turnUrl: string;
  /** The thread as the server rendered it, which also seeds the high-water mark. */
  initial: ChatMessageView[];
  /** A turn was in flight when the page rendered. */
  running: boolean;
};

export type TurnStream = {
  /** Everything on screen, oldest first. */
  bubbles: Bubble[];
  /** A turn is in flight and this page is watching it. */
  busy: boolean;
  /** A message typed mid-turn and held back until this one ends. */
  queued: string | null;
  setQueued: (message: string | null) => void;
  /** Say something and start a turn on it. */
  send: (message: string) => void;
  /** Put a message on screen without starting a turn — for steering, where the
   *  message is appended server-side and the stream will not replay it. */
  echo: (text: string) => void;
  /** The app talking rather than the model: shown in the conversation, never
   *  stored in it, and a reload is right to forget it. */
  say: (kind: "notice" | "error", text: string) => void;
};

export function useTurnStream({ turnUrl, initial, running }: Options): TurnStream {
  const router = useRouter();
  const [bubbles, setBubbles] = useState<Bubble[]>(() => toBubbles(initial));
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const started = useRef(false);
  const sending = useRef(false);
  // How far this page has read the thread. Advanced by every `message` event, so a
  // reconnect asks for the rest rather than the whole turn again.
  const since = useRef(initial.reduce((high, message) => Math.max(high, message.seq), -1));

  const push = useCallback(
    (bubble: Bubble) => setBubbles((prev) => [...prev, bubble]),
    [],
  );

  const say = useCallback(
    (kind: "notice" | "error", text: string) => push({ key: crypto.randomUUID(), kind, text }),
    [push],
  );

  const echo = useCallback(
    (text: string) => push({ key: crypto.randomUUID(), kind: "user", text }),
    [push],
  );

  const open = useCallback(
    async (message: string, mode: "start" | "watch") => {
      setBusy(true);
      const controller = new AbortController();
      abort.current = controller;

      // A bubble the stream will append to, created on the first delta rather than
      // now: a turn that opens with a tool call should not leave an empty one behind.
      let streaming: string | null = null;
      // The same, for the stretch of reasoning being written. Cleared — not emptied —
      // by the next thing the model does, which leaves the block on screen and starts
      // a new one if it thinks again.
      let reasoning: string | null = null;

      /** Close the reasoning block, if one is open, and stop it pulsing. */
      const settle = () => {
        const key = reasoning;
        if (key === null) return;
        reasoning = null;
        setBubbles((prev) =>
          prev.map((b) => (b.key === key && b.kind === "thinking" ? { ...b, live: false } : b)),
        );
      };

      try {
        const response = await fetch(turnUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            since: since.current,
            ...(mode === "watch" ? { attach: true } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const detail = await response
            .json()
            .then((body: { error?: string }) => body.error)
            .catch(() => null);
          push({ key: crypto.randomUUID(), kind: "error", text: detail ?? "Could not start." });
          return;
        }

        for await (const event of readEvents(response.body)) {
          switch (event.t) {
            case "delta": {
              // Speech ends the reasoning block: it thought, and now it is answering.
              settle();
              const key = streaming;
              if (key === null) {
                const fresh = crypto.randomUUID();
                streaming = fresh;
                push({ key: fresh, kind: "assistant", text: event.text });
              } else {
                setBubbles((prev) =>
                  prev.map((b) =>
                    b.key === key && b.kind === "assistant" ? { ...b, text: b.text + event.text } : b,
                  ),
                );
              }
              break;
            }

            case "thinking": {
              // A bubble of its own, in the order it happened, so what the model was
              // working through before a tool call or an answer is still there to read
              // afterwards. Never written to the thread — see ./thinking.tsx.
              const key = reasoning;
              if (key === null) {
                const fresh = crypto.randomUUID();
                reasoning = fresh;
                push({ key: fresh, kind: "thinking", text: event.text, live: true });
              } else {
                setBubbles((prev) =>
                  prev.map((b) =>
                    b.key === key && b.kind === "thinking" ? { ...b, text: b.text + event.text } : b,
                  ),
                );
              }
              break;
            }

            case "tool_call":
              streaming = null;
              settle();
              push({
                key: crypto.randomUUID(),
                kind: "tool",
                callId: event.id,
                name: event.name,
                args: event.args,
              });
              break;

            case "tool_result":
              setBubbles((prev) =>
                prev.map((b) =>
                  b.kind === "tool" && b.callId === event.id ? { ...b, result: event.data } : b,
                ),
              );
              break;

            case "message":
              // The high-water mark, and the only thing that moves it. Everything on
              // screen up to here is now also a row, so a reconnect need not replay it.
              since.current = Math.max(since.current, event.seq);
              break;

            case "cancelled":
              streaming = null;
              settle();
              push({ key: crypto.randomUUID(), kind: "notice", text: "Stopped." });
              break;

            case "error":
              streaming = null;
              settle();
              push({ key: crypto.randomUUID(), kind: "error", text: event.message });
              break;

            case "title":
              // The thread list and the header live in server components.
              router.refresh();
              break;
          }
        }
      } catch (error) {
        // An abort here is the page going away, not the stop button — stopping is a
        // server action. The turn carries on server-side and its messages are persisted,
        // so coming back re-attaches to it.
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          push({
            key: crypto.randomUUID(),
            kind: "error",
            text: "Lost the connection. Reload to see how the turn finished.",
          });
        }
      } finally {
        abort.current = null;
        setBusy(false);
        // A turn that ended on reasoning — the connection dropped, or it thought and
        // then said nothing — leaves the block on screen, no longer pulsing.
        settle();
        // Budgets it may have written, and the thread's own updatedAt.
        router.refresh();
      }
    },
    [push, router, turnUrl],
  );

  const send = useCallback(
    (message: string) => {
      echo(message);
      void open(message, "start");
    },
    [echo, open],
  );

  // Pick up whatever this thread is doing. Three cases, one rule: a turn in flight is
  // watched, a thread left ending on a question is continued, and a finished
  // conversation is left alone.
  //
  // Deferred by a tick rather than run inline, for two reasons. The thread paints
  // before the request goes out, so arriving at a long conversation is not a blank
  // screen; and starting a turn sets state, which inside an effect body would be a
  // cascading render (`react-hooks/set-state-in-effect`). No cleanup on purpose — the
  // ref is what makes this fire once, and clearing the timer would have Strict Mode's
  // second pass find the ref already set and never start at all.
  useEffect(() => {
    if (started.current) return;
    // A thread ending on a question, or on a tool result, is one mid-answer: the
    // model was about to speak and the process died, or the tab was closed. Ending on
    // an assistant message is a finished turn and nothing to resume.
    const last = initial[initial.length - 1];
    const unfinished = last?.role === "user" || last?.role === "tool";
    if (!running && !unfinished) return;
    started.current = true;
    // `watch` when the server said a turn was running: it is somebody else's to finish,
    // and asking to start one would race its ending. `start` otherwise — the thread is
    // sitting on an unanswered question, which is the seeded-thread case.
    setTimeout(() => void open("", running ? "watch" : "start"), 0);
  }, [initial, running, open]);

  // A message typed while the model was working and held back deliberately. Sent when
  // the turn ends, as its own turn — the difference from steering is that it waits for
  // the answer rather than interrupting it.
  //
  // All of it deferred a tick, state included: setting state straight from an effect
  // body is a cascading render (`react-hooks/set-state-in-effect`). The ref is what keeps
  // the gap between deciding to send and `busy` becoming true from being a second send.
  useEffect(() => {
    if (busy || queued === null || sending.current) return;
    sending.current = true;
    const message = queued;
    setTimeout(() => {
      sending.current = false;
      setQueued(null);
      send(message);
    }, 0);
  }, [busy, queued, send]);

  return { bubbles, busy, queued, setQueued, send, echo, say };
}

type StreamEvent =
  | { t: "delta"; text: string }
  | { t: "thinking"; text: string }
  | { t: "tool_call"; id: string; name: string; args: string }
  | { t: "tool_result"; id: string; name: string; data: unknown }
  | { t: "message"; id: string; seq: number; role: string }
  | { t: "title"; title: string }
  | { t: "error"; message: string }
  | { t: "cancelled" }
  | { t: "done" };

/** The response body as events. Chunks split anywhere, including mid-object, so the
 *  tail of a chunk is held back until its newline arrives. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as StreamEvent;
      } catch {
        // A malformed line is one lost event, not a lost turn.
      }
    }
  }
}
