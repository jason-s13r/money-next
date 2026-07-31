"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessagesSquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Composer } from "@/ui/chat/composer";
import { continueLog, stopRun, tellRun } from "../actions";

// What you can do to a background run from the log it is writing.
//
// The same composer as everywhere else (ui/chat/composer.tsx), given the two handlers that
// mean anything here — and not the ones that do not. There is no model to choose (the run
// picked one an hour ago), nothing to compact, and no `/commands`, because those are
// addressed to the app about a thread and this is a record of a worker. What is left is
// Send and Stop, which is exactly what the composer shows when it is given exactly those.
//
//   **Send** appends a message the run reads at the top of its next round. Not an
//   interrupt: the step in flight is a completion in another process, and nothing short of
//   a shared registry could cut one short. The line under the box says so rather than
//   implying an immediacy it does not have.
//
//   **Stop** ends the reading and has it build the budget from what it has proposed so
//   far. The run has usually spent minutes on the areas it did reach, and throwing that
//   away is not what anybody means by stop.
//
//   **Continue** is for afterwards, and is not a composer at all — there is nothing to
//   type yet. It takes the finished log over as an ordinary conversation, in place, and
//   from then on this page is the ordinary one. See `continueLog`.
//
// The page around this refreshes every few seconds while the run is going
// (`<AutoRefresh>`), which is how what you say appears in the thread and how you see the
// run react to it — there is nothing to stream from a process this one cannot see.

export function LogControls({ threadId, running }: { threadId: string; running: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const act = (run: () => Promise<{ error: string | null }>) => {
    setError(null);
    start(async () => setError((await run()).error));
  };

  if (!running) {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-border px-2 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">
            The log of a budget inference that ran in the background. Carry it on and the
            model picks up everything it read, as a conversation.
          </p>
          {error ? (
            <p role="alert" className="mt-1 text-xs text-status-critical">
              {error}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          className="shrink-0"
          // The page has to become a different page — a log renders read-only and a
          // conversation renders a composer — so the refresh is asked for rather than left
          // to the revalidation the action does for the thread list.
          onClick={() =>
            act(async () => {
              const state = await continueLog(threadId);
              if (!state.error) router.refresh();
              return state;
            })
          }
        >
          <MessagesSquareIcon />
          {pending ? "Opening…" : "Continue this conversation"}
        </Button>
      </div>
    );
  }

  return (
    <>
      {error ? (
        <p role="alert" className="px-2 text-xs text-status-critical">
          {error}
        </p>
      ) : null}

      {/* `running` because that is what it is — a model is working — even though the turn
          is not ours to steer. Send and Stop are what the composer offers when they are
          the only two handlers it is given. */}
      <Composer
        state="running"
        placeholder="Say something to the run — a different emphasis, an area to leave alone…"
        onSend={(message) => act(() => tellRun(threadId, message))}
        onStop={() => act(() => stopRun(threadId))}
      />

      <p className="px-2 pb-3 text-xs text-muted">
        The run is working in the background. It reads this between steps, so expect a wait
        — and stopping keeps everything it has proposed so far.
      </p>
    </>
  );
}
