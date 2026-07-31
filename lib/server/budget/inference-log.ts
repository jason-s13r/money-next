// No `import "server-only"`: this runs in the worker (scripts/drain.ts → ./run.ts),
// which is plain Node where `server-only` throws. It takes its scoped db as an
// argument for the same reason.
import type { ScopedDb } from "../db";
import { appendMessage } from "../chat/thread";
import { formatDateTime } from "../../format";

// The log of one unattended budget inference, written as a conversation.
//
// A budget inference is a conversation — the model reads an area, proposes for it, and
// moves on — held with nobody watching. It used to leave a transcript file under
// `LLM_LOG_DIR`: opt-in, off by default, and in practice unread, because reading it
// meant finding a directory on whichever machine the worker happened to run on. The
// conversation now goes where the interactive chat's already does, as `ChatThread` and
// `ChatMessage` rows, so "what did it actually read, and why did it budget that?" is a
// link on the budgets page rather than an ssh session.
//
// **The log is the conversation, not a rendering of it.** Every message is stored in
// the same shape a chat's is — an assistant row carrying its `tool_calls`, a `tool` row
// per result — so the existing thread page renders a run with no work at all, and the
// elision the run performs in flight is recorded as the same `elided` flag a chat uses.
// The run's own commentary (what model, how much history, what it fell back to) is
// `system`, which is the one role that is never sent to a model: it is this app talking
// about the run, not anything that was said in it.
//
// **It is owned.** A thread is private to its author, so the log belongs to whoever
// asked for the run (`BudgetInferenceRun.userId`); with nobody to own it — an older run,
// or one enqueued with no session behind it — `openInferenceLog` returns null and the
// run is logged to the console only, as it always was.
//
// **And it is the way back in.** The log started as a transcript, written one way. But a
// run in the worker is unreachable from the app — no registry to find it in, no signal to
// send it, none of what makes the interactive chat's stop and steer work — and the log is
// already a row both processes can see. So `heard` and `stopRequested` read the other
// direction: what the person watching has typed into the thread, and whether they have
// asked it to stop. The loop drains both between rounds (./llm.ts), which is why saying
// something to a run lands after the step in flight rather than during it.
//
// Nobody may take a *turn* in a running log — that would be two writers on one thread —
// so what the person says goes in as a plain `user` row and the run picks it up. Once the
// run is over the thread can be taken over outright: see `ChatThread.continuedAt`.
//
// **A log write never breaks a run.** Every write below is best-effort. The inference is
// the work; the log is the account of it, and losing a paragraph of the account is not a
// reason to lose a household's budget.

/** One tool call, as the log needs it — the SDK's shape, narrowed. */
export type LoggedCall = { id: string; name: string; input: unknown };

/**
 * An open log. Nothing here throws: a failed write is reported to the worker log once
 * and the run carries on.
 */
export type InferenceLog = {
  /** The thread the run is writing into. Recorded on the run row, so the budgets page
   *  can link to a log while it is still being written. */
  threadId: string;
  /** The run talking about itself. Never sent to a model — see the note above. */
  note(text: string): Promise<void>;
  /** What the run asked the model: the opening brief, or a nudge mid-run. */
  asked(text: string): Promise<void>;
  /** One round's reply: what it said, and what it asked for. */
  said(text: string, calls: LoggedCall[]): Promise<void>;
  /** What a tool answered. Stored whole, like a chat's — the pages of transactions are
   *  the evidence for the budget, and are the reason to keep a log at all. */
  answered(call: { id: string; name: string }, output: unknown): Promise<void>;
  /** Mark served pages as dropped from the model's view, the same decision the run
   *  makes in the conversation itself. The rows keep their contents. */
  elide(callIds: string[]): Promise<void>;
  /**
   * Anything the person watching has said to the run since this was last called, in
   * the order they said it. Empty almost always — a run is normally watched in
   * silence, if at all.
   *
   * Their words are already rows (that is how they got here), so the caller pushes
   * them into the model's conversation and does *not* log them again.
   */
  heard(): Promise<string[]>;
  /** Whether somebody has asked this run to stop reading and build the budget from
   *  what it has. Checked between rounds; see `BudgetInferenceRun.stopRequestedAt`. */
  stopRequested(): Promise<boolean>;
  /** Release the claim, so the thread stops saying it is working. */
  close(): Promise<void>;
};

/**
 * Open a thread to log a run into, or return null when there is nobody to own one.
 *
 * The thread is claimed (`runningSince`) from the start, so /chat shows the log as
 * working and the log page pulls itself while the worker writes. A worker that dies
 * mid-run leaves the claim set, which is what it means — the same reading `ChatThread`
 * already gives it for a chat killed by a restart.
 */
export async function openInferenceLog(
  db: ScopedDb,
  run: { id: string; userId: string | null; reinfer: boolean; now: Date },
): Promise<InferenceLog | null> {
  if (!run.userId) return null;

  try {
    const thread = await db.chatThread.create({
      data: {
        workspaceId: db.$workspaceId,
        userId: run.userId,
        title: `${run.reinfer ? "Budget re-inference" : "Budget inference"} — ${formatDateTime(run.now)}`,
        unattended: true,
        runningSince: run.now,
      },
      select: { id: true },
    });

    // Written back immediately rather than at the end: a log is most worth reading
    // while the run is still going, and the run row is how the budgets page finds it.
    await db.budgetInferenceRun.updateMany({
      where: { id: run.id },
      data: { threadId: thread.id },
    });

    return logInto(db, thread.id, run.id);
  } catch (error) {
    console.error("  [llm] could not open a log thread for this run:", error);
    return null;
  }
}

/** The log, once there is a thread to write into. */
function logInto(db: ScopedDb, threadId: string, runId: string): InferenceLog {
  /**
   * The `user` rows already accounted for: the ones this run wrote itself — the
   * opening brief, and each nudge — and the ones it has picked up from the person
   * watching.
   *
   * `heard` is "every user row that is not one of these", which is exact where a
   * high-water seq would not be: a person can type while the run is mid-round, so
   * their message can take a seq *below* one the run goes on to write, and a mark that
   * only moves forward would step over it. The set stays small — a run says a handful
   * of things, and a person watching one says fewer.
   */
  const accounted = new Set<string>();

  /** Every write goes through here: a log that cannot be written is worth one line in
   *  the worker log and nothing more. */
  const safely = async <T>(what: string, write: () => Promise<T>): Promise<T | null> => {
    try {
      return await write();
    } catch (error) {
      console.error(`  [llm] could not log ${what}:`, error);
      return null;
    }
  };

  const append = async (
    what: string,
    message: Parameters<typeof appendMessage>[2],
  ): Promise<void> => {
    const row = await safely(what, () => appendMessage(db, threadId, message));
    if (row && message.role === "user") accounted.add(row.id);
  };

  return {
    threadId,

    note: (text) => append("a note", { role: "system", content: text }),

    asked: (text) => append("the brief", { role: "user", content: text }),

    said: (text, calls) =>
      append("a reply", {
        role: "assistant",
        content: text.trim() ? text : null,
        // The stored shape is the API's, verbatim, exactly as a chat stores it — which
        // is what lets one renderer show both.
        toolCalls:
          calls.length > 0
            ? calls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
              }))
            : undefined,
      }),

    answered: (call, output) =>
      append("a tool result", {
        role: "tool",
        content: JSON.stringify(output ?? null),
        toolCallId: call.id,
        toolName: call.name,
      }),

    elide: async (callIds) => {
      if (callIds.length === 0) return;
      await safely("an elision", () =>
        db.chatMessage.updateMany({
          where: { threadId, toolCallId: { in: callIds } },
          data: { elided: true },
        }),
      );
    },

    heard: async () => {
      // Read, then claimed: a row returned here is one the caller is about to put in
      // front of the model, so it must not come back a second time even if the round
      // it lands in fails. Losing an instruction to a crashed round is the lesser
      // wrong — the person can see it went unanswered and say it again.
      const rows = await safely("a read of what was said to the run", () =>
        db.chatMessage.findMany({
          where: { threadId, role: "user", id: { notIn: [...accounted] } },
          orderBy: { seq: "asc" },
          select: { id: true, content: true },
        }),
      );
      if (!rows) return [];

      const said: string[] = [];
      for (const row of rows) {
        accounted.add(row.id);
        if (row.content?.trim()) said.push(row.content);
      }
      return said;
    },

    stopRequested: async () => {
      const run = await safely("a check for a stop", () =>
        db.budgetInferenceRun.findFirst({
          where: { id: runId },
          select: { stopRequestedAt: true },
        }),
      );
      // A failed read is not a stop. The run carries on and asks again next round,
      // which is the same answer a moment later.
      return run?.stopRequestedAt != null;
    },

    close: async () => {
      await safely("the end of the run", () =>
        // `updatedAt` is `@updatedAt`, so this also floats the finished log to the top
        // of the thread list — the same touch the chat's turn does when it settles.
        db.chatThread.updateMany({ where: { id: threadId }, data: { runningSince: null } }),
      );
    },
  };
}
