import type { ChatMessageView, ChatThreadView } from "@/lib/chat/messages";
import { BubbleView, toBubbles } from "@/ui/chat/bubbles";
import { AutoRefresh } from "@/ui/primitives/auto-refresh";
import { LogControls } from "./log-controls";
import { LogHeader } from "./log-header";

// The log of an unattended run, read.
//
// Same rows and the same bubbles as a conversation, and deliberately none of the machinery
// around them: no stream to attach to, no turn, no client state but the little in
// `<LogControls>`. A log is written by the `money_sync` worker in another process
// (lib/server/budget/inference-log.ts), and taking a turn in it is refused by the turn
// route whatever a page offers — see `ChatThread.unattended`.
//
// What can be done to it is at the bottom, and it is not a composer: say something to the
// run, stop it, or — once it is over — take the log over and carry it on as a
// conversation. All three go through server actions, because none of them is a turn.
//
// While the run is going, `<AutoRefresh>` pulls the page every few seconds, the same way
// the budgets page watches the run that is writing this. That is the whole live story:
// the worker cannot revalidate a page it has never heard of, and a re-render of a server
// component reads the rows again.

export function LogView({
  thread,
  messages,
}: {
  thread: ChatThreadView;
  messages: ChatMessageView[];
}) {
  return (
    <>
      <LogHeader thread={thread} />
      <AutoRefresh active={thread.running} />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 py-4">
        {toBubbles(messages).map((bubble) => (
          <BubbleView key={bubble.key} bubble={bubble} />
        ))}

        {thread.running ? (
          <p className="px-1 text-sm text-muted-foreground">Still working…</p>
        ) : null}
      </div>

      <LogControls threadId={thread.id} running={thread.running} />
    </>
  );
}
