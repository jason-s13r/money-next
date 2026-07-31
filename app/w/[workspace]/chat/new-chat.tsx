"use client";

import { useState, useTransition } from "react";

import { helpText, type ParsedCommand } from "@/lib/chat/commands";
import { Composer } from "@/ui/chat/composer";
import { createThread } from "./actions";
import { NO_ERROR } from "./types";

// Starting a conversation.
//
// The same composer a thread has (ui/chat/composer.tsx), in its `new` state: there is no
// turn to stop or redirect and nothing yet to summarise, so none of that is on screen —
// but **which model answers is on screen**, and that is the point of using it here. It was
// a plain form, and the only way to pick a model was to start a conversation on the wrong
// one and switch; the choice belongs before the first question, because the first question
// is usually the one that decides whether the small model can cope.
//
// The choice is held here and sent with the message, so the thread is created already
// pinned. Nothing else is: the action creates the thread, stores the first message and
// redirects, and the thread page starts the turn on arrival because the last message there
// is a question with no answer.

export function NewChat({ defaultModel }: { defaultModel: string }) {
  const [model, setModel] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const send = (message: string) => {
    setError(null);
    const form = new FormData();
    form.set("message", message);
    if (model) form.set("model", model);
    // The action redirects on success, so there is nothing to do after it but report the
    // one way it can come back: something went wrong and we are still here. Read
    // defensively — a call that redirected has navigated away rather than answered, and
    // reaching into what it did not return would replace the new page with a crash.
    start(async () => {
      const state = await createThread(NO_ERROR, form);
      setError(state?.error ?? null);
    });
  };

  /** The two commands that mean anything with no thread yet — see `ChatState`. */
  const onCommand = ({ command, rest }: ParsedCommand) => {
    setError(null);
    if (command.name === "help") return setNotice(helpText("new"));
    if (command.name !== "model") return;
    if (!rest) return setNotice("Name one with /model <name>, or pick it below.");
    // Naming the default is choosing not to pin, the same rule the picker follows.
    const chosen = rest === defaultModel ? null : rest;
    setModel(chosen);
    setNotice(`This chat will use ${chosen ?? defaultModel}.`);
  };

  return (
    <div className="flex flex-col gap-2">
      {notice ? <p className="px-1 font-mono text-xs whitespace-pre-wrap text-muted">{notice}</p> : null}

      {error ? (
        <p role="alert" className="px-1 text-sm text-status-critical">
          {error}
        </p>
      ) : null}

      <Composer
        state="new"
        // No divider and no padding of its own: it is the page's own block here, not the
        // foot of a conversation it has to be separated from.
        className="border-t-0 px-0 py-0"
        onSend={send}
        placeholder={
          pending
            ? "Starting…"
            : "What did I spend on groceries last month? Where is my money going? Help me build a budget…"
        }
        model={model}
        defaultModel={defaultModel}
        onChooseModel={(next) => {
          setNotice(null);
          setModel(next);
        }}
        onCommand={onCommand}
      />
    </div>
  );
}
