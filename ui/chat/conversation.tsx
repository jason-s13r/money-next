"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { BubbleView } from "./bubbles";
import { Composer } from "./composer";
import { useTurnStream } from "./use-turn-stream";
import {
  compactThread,
  listModels,
  setThreadModel,
  steerTurn,
  stopTurn,
} from "@/app/w/[workspace]/chat/actions";
import { helpText, type ParsedCommand } from "@/lib/chat/commands";
import type { ChatMessageView } from "@/lib/chat/messages";

// The conversation: what a reader can say to a thread, and what it looks like.
//
// The stream itself is not here. Attaching to a turn, reading its newline-delimited
// JSON, and turning that into bubbles is ./use-turn-stream.ts — this component
// consumes `bubbles` and `busy` and otherwise knows nothing about the wire. What
// is left is the part a reader would recognise: the slash commands, the model the
// thread is pinned to, compaction, and the layout.
//
// How a conversation *looks* is one level further down again, in ./bubbles.tsx,
// shared with the read-only view of an unattended run's log — which has no stream
// and no composer to need any of this.

type Props = {
  threadId: string;
  turnUrl: string;
  initial: ChatMessageView[];
  /** The model this thread is pinned to, if any. Null follows the server's default. */
  model: string | null;
  /** What that default is, so the composer can name it rather than say "default". Read
   *  from the environment during the page's render — no call to the endpoint. */
  defaultModel: string;
  /** A turn was in flight when the page rendered. */
  running: boolean;
  /** False for a viewer: the model still reads and explains, it just cannot write. */
  canEdit: boolean;
};

export function Conversation({
  threadId,
  turnUrl,
  initial,
  model,
  defaultModel,
  running,
  canEdit,
}: Props) {
  const router = useRouter();
  const { bubbles, busy, queued, setQueued, send, echo, say } = useTurnStream({
    turnUrl,
    initial,
    running,
  });
  // The thread's model, held here as well as on the row: choosing one has to change what
  // the composer says immediately, and the row is a server render away.
  const [pinned, setPinned] = useState(model);
  const [compacting, setCompacting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [bubbles]);

  // Redirect the turn in flight. The message is appended server-side, so it arrives in
  // the conversation the next round rebuilds; the bubble is echoed here because this
  // page is watching a stream that will not replay a message it did not emit.
  const onSteer = (message: string) => {
    echo(message);
    void steerTurn(threadId, message).then((state) => {
      if (state.error) say("error", state.error);
    });
  };

  /**
   * Summarise the older part of the thread. One function for the button and for
   * `/compact`, because they are the same act and the second was already routed through
   * the first's answer — a notice in the conversation rather than an error beside a
   * header button.
   */
  const compact = () => {
    if (busy) return say("error", "Wait for this answer to finish, then compact.");
    if (compacting) return;
    setCompacting(true);
    void compactThread(threadId)
      .then((state) => {
        if (state.error) return say("error", state.error);
        say("notice", "Summarised the earlier messages. They are all still here to read.");
        router.refresh();
      })
      .finally(() => setCompacting(false));
  };

  /** Pin this thread to a model, or clear the pin back to the server's default. Held in
   *  state as well as written, so the composer changes as the menu closes rather than
   *  when the router next re-renders the page. */
  const chooseModel = (next: string | null) => {
    setPinned(next);
    void setThreadModel(threadId, next).then((state) => {
      if (state.error) return say("error", state.error);
      router.refresh();
    });
  };

  /** Run what was typed as a `/command`. Nothing here reaches the model — see
   *  lib/chat/commands.ts — so each one is a server action and a sentence about it. */
  const onCommand = ({ command, rest }: ParsedCommand) => {
    switch (command.name) {
      case "help":
        say("notice", helpText(busy ? "running" : "idle"));
        return;

      case "stop":
        if (!busy) return say("notice", "Nothing is running.");
        void stopTurn(threadId).then((state) => {
          if (state.error) say("error", state.error);
        });
        return;

      case "steer":
        if (!rest) return say("error", "Say what you want it to do instead: /steer …");
        // Nothing to interrupt: what they typed is simply the next thing said, which is
        // what they meant. Losing it to a turn that ended a second ago would not be.
        return busy ? onSteer(rest) : send(rest);

      case "next":
        if (!rest) return say("error", "Say what to send next: /next …");
        if (!busy) return send(rest);
        setQueued(rest);
        return;

      case "compact":
        compact();
        return;

      case "model":
        if (!rest) {
          void listModels().then((models) => {
            if (models.length === 0) {
              return say("notice", "Could not list models. The endpoint may be unreachable.");
            }
            const lines = models.map((name) =>
              [
                name,
                name === (pinned ?? defaultModel) ? "← this chat" : null,
                name === defaultModel ? "(the default)" : null,
              ]
                .filter(Boolean)
                .join("  "),
            );
            say("notice", `${lines.join("\n")}\n\nSwitch with /model <name>.`);
          });
          return;
        }
        // Deliberately allowed mid-turn, unlike the picker: the turn in flight is already
        // talking to something, and saying so is clearer than refusing. Naming the
        // default unpins rather than pins, the same rule the picker follows.
        chooseModel(rest === defaultModel ? null : rest);
        say("notice", busy ? `Next turn will use ${rest}.` : `Now using ${rest}.`);
        return;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 py-4">
        {bubbles.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Ask about your spending, or about a budget.
          </p>
        ) : null}

        {bubbles.map((bubble) => (
          <BubbleView key={bubble.key} bubble={bubble} />
        ))}

        {/* Only until there is something better to look at. A tool card or a block of
            reasoning already says the turn is alive, and says what it is doing. */}
        {busy && !["tool", "thinking"].includes(bubbles[bubbles.length - 1]?.kind ?? "") ? (
          <p className="px-1 text-sm text-muted-foreground">Thinking…</p>
        ) : null}

        <div ref={bottom} />
      </div>

      <Composer
        state={busy ? "running" : "idle"}
        canEdit={canEdit}
        queued={queued}
        model={pinned}
        defaultModel={defaultModel}
        compacting={compacting}
        onSend={send}
        onSteer={onSteer}
        onQueue={setQueued}
        onUnqueue={() => setQueued(null)}
        onStop={() => void stopTurn(threadId)}
        onCompact={compact}
        onChooseModel={chooseModel}
        onCommand={onCommand}
      />
    </div>
  );
}
