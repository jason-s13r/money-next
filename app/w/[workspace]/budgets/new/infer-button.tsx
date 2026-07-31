"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { BUDGET_PROMPT } from "@/lib/chat/messages";
import { useCanEdit } from "@/ui/chrome/workspace-context";
import { createThread } from "../../chat/actions";
import { NO_ERROR as NO_CHAT_ERROR, type ChatActionState } from "../../chat/types";
import { startBudgetInference } from "../actions";
import { NO_ERROR, type BudgetActionState } from "../types";

// Two ways to have the AI build a budget, and the difference between them is whether
// you are in the room.
//
// **In a chat** is the default now. The model works through the history the same way,
// but out loud: it says what it found in each area, you push back on the figures, and
// nothing is written until you agree to it. Not a link — the thread has to be created
// and seeded with the opening prompt first, which is a server action; the page it
// lands on starts the turn because the last message there is a question with no
// answer.
//
// **In the background** is the old path, kept because it is the one that works when
// nobody is sitting there: a `BudgetInferenceRun` row, the worker, and a finished
// budget on the list a minute later. It is also the path with the deterministic
// fallback, so it still produces a budget on a machine with no model at all. The
// re-infer button on an existing budget uses it too.

export function InferButton() {
  const canEdit = useCanEdit();

  const [chatState, startChat] = useActionState<ChatActionState, FormData>(
    createThread,
    NO_CHAT_ERROR,
  );
  const [runState, startRun] = useActionState<BudgetActionState, FormData>(
    startBudgetInference,
    NO_ERROR,
  );

  if (!canEdit) {
    return <p className="text-sm text-muted">Your role can read budgets but not create them.</p>;
  }

  const error = chatState.error ?? runState.error;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form action={startChat}>
          <input type="hidden" name="message" value={BUDGET_PROMPT} />
          <Submit idle="Build a budget with AI" busy="Opening…" />
        </form>

        <form action={startRun}>
          <Submit idle="Or run it in the background" busy="Starting…" variant="outline" />
        </form>
      </div>

      <p className="text-xs text-muted">
        Both read your history with your configured local AI. In a chat you see what it
        found and approve each part; in the background it builds the whole budget itself
        and turns up on the budgets list.
      </p>

      {error ? (
        <p role="alert" className="text-sm text-status-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Its own component so `useFormStatus` reads the form it is inside, not the page. */
function Submit({
  idle,
  busy,
  variant,
}: {
  idle: string;
  busy: string;
  variant?: "outline";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} variant={variant}>
      {pending ? busy : idle}
    </Button>
  );
}
