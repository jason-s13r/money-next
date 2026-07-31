"use server";

import { redirect } from "next/navigation";

import { requireRole } from "@/lib/server/auth/session";
import { availableModels } from "@/lib/server/chat/client";
import { compactThread as compact } from "@/lib/server/chat/compact";
import { cancelRun, isRunning, steerRun } from "@/lib/server/chat/runs";
import { appendMessage } from "@/lib/server/chat/thread";
import { getDb } from "@/lib/server/db/request";
import type { ScopedDb } from "@/lib/server/db";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { workspacePath } from "@/lib/workspace-path";
import { titleFrom } from "@/lib/chat/messages";
import { NO_ERROR, type ChatActionState } from "./types";
import { text } from "@/lib/form-data";

/** The most characters a thread title may hold. The schema column is unbounded, so
 *  the cap lives here. */
const MAX_TITLE_LENGTH = 200;

// Server actions behind `/chat`.
//
// The thread itself is managed here — created, renamed, deleted — and so is the turn
// running on it: stopped, or redirected. Saying something *in* a thread is not an
// action: it streams for a minute, and Next dispatches server actions one at a time per
// client and answers each with a single response. That is the route handler at
// `[thread]/turn/route.ts`.
//
// Stop and steer are actions rather than part of that route precisely because they are
// the opposite shape — one small statement, one small answer, and no waiting. They reach
// the running turn through the in-process registry (lib/server/chat/runs.ts), which is
// what a turn is addressable by now that it no longer belongs to the request that began
// it.
//
// Every exported action opens with `requireRole({ chat: ["use"] })`, which
// `tests/actions.test.ts` scans for. `chat.use` is held by every role including
// viewer — see lib/server/auth/roles.ts for why it exists at all when reading is
// otherwise just membership.
//
// **Threads are private to their author.** Each write below carries `userId` in its
// filter for the same reason lib/server/queries/chat.ts does: `scopedDb` and the RLS
// policy beneath it both key on the workspace, so neither keeps out the other member
// of a household. A `updateMany`/`deleteMany` that matches nothing is the right answer
// to "someone else's thread" — it is indistinguishable from "no such thread", which is
// what a stranger should learn.

/**
 * Open a new conversation and go to it.
 *
 * The opening message is optional. With one, the thread is titled from it, persisted,
 * and the page starts the turn on arrival — which is what makes "Infer a budget with
 * AI" land in a conversation that is already working. Without one, you get an empty
 * thread and a composer.
 *
 * `model` is optional too, and only ever set by the composer on /chat: which model
 * answers is worth deciding before the first question, not after the first answer, and
 * the alternative was opening a thread on the wrong model and switching. Absent means
 * the thread follows `LLM_MODEL`, which is every thread opened from anywhere else.
 */
export async function createThread(
  _prev: ChatActionState,
  form: FormData,
): Promise<ChatActionState> {
  const { workspace, user } = await requireRole({ chat: ["use"] });
  const db = await getDb();

  const message = text(form, "message");
  const thread = await db.chatThread.create({
    data: {
      workspaceId: db.$workspaceId,
      userId: user.id,
      title: message ? titleFrom(message) : "New chat",
      model: text(form, "model") || null,
    },
    select: { id: true },
  });

  if (message) {
    await db.chatMessage.create({
      data: {
        workspaceId: db.$workspaceId,
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: message,
      },
    });
  }

  await revalidateWorkspacePath("/chat");
  redirect(workspacePath(workspace.slug, `/chat/${thread.id}`));
}

/**
 * Stop the turn running on a thread.
 *
 * Saying so, as opposed to closing the tab, which deliberately does not mean this. What
 * the model has already said is kept and what it had asked for is answered with a
 * cancellation — see lib/server/chat/run.ts — so a stopped conversation is still one you
 * can carry on.
 *
 * Returns quietly when nothing is running: the button was pressed on the last frame of a
 * turn that had just finished, which is not something to report as an error.
 */
export async function stopTurn(threadId: string): Promise<ChatActionState> {
  const { user } = await requireRole({ chat: ["use"] });
  const db = await getDb();

  if (!(await ownThread(db, threadId, user.id))) {
    return { error: "No such conversation." };
  }

  cancelRun(threadId);
  return NO_ERROR;
}

/**
 * Redirect a turn that is already running: append the instruction and cut the completion
 * in flight short so the loop picks it up now rather than after the model has finished
 * whatever it had embarked on.
 *
 * This is the answer to a model three tool calls into the wrong idea. Stopping and asking
 * again would work and would throw away the tool results it has already gathered; this
 * keeps them, because they are in the thread and every round is rebuilt from the thread.
 */
export async function steerTurn(threadId: string, message: string): Promise<ChatActionState> {
  const { user } = await requireRole({ chat: ["use"] });
  const db = await getDb();

  const said = message.trim();
  if (!said) return { error: "Say what you want it to do instead." };

  if (!(await ownThread(db, threadId, user.id))) {
    return { error: "No such conversation." };
  }

  // Written whether or not a turn is there to redirect. If the turn ended half a second
  // ago the instruction is simply the next thing in the conversation, which is what the
  // person meant either way — losing what they typed to a race is the one outcome that
  // is definitely wrong.
  await appendMessage(db, threadId, { role: "user", content: said });
  steerRun(threadId);
  return NO_ERROR;
}

/**
 * What the configured endpoint is serving right now.
 *
 * An action rather than page data because it is a network call to another process, and
 * one that has nothing to do with rendering a conversation: a page should not wait on
 * `LLM_API` to paint, and a picker nobody opens should not have asked. Empty when the
 * endpoint is unset or unreachable, which the caller shows as "cannot list models"
 * rather than as an error — the configured default still works.
 */
export async function listModels(): Promise<string[]> {
  await requireRole({ chat: ["use"] });
  return availableModels();
}

/**
 * Choose which model answers in this thread, or clear the choice back to the default.
 *
 * Takes effect on the next turn: the one in flight is already talking to something.
 * Unvalidated against the list on purpose — the list comes from whatever `LLM_API` is
 * serving right now, and a model that has since been unloaded should fail as a model
 * that is not there rather than as a form that will not submit.
 */
export async function setThreadModel(
  threadId: string,
  model: string | null,
): Promise<ChatActionState> {
  const { user } = await requireRole({ chat: ["use"] });
  const db = await getDb();

  await db.chatThread.updateMany({
    where: { id: threadId, userId: user.id },
    data: { model: model?.trim() || null },
  });

  await revalidateWorkspacePath("/chat");
  return NO_ERROR;
}

/**
 * Summarise the older part of a conversation so the model stops carrying it.
 *
 * Nothing is deleted — the messages stay on the page, and only the model's view moves
 * forward. Refused while a turn is running: the summary would be written from a
 * conversation that is changing underneath it, and the turn's next round would pick up a
 * cut point it had not seen.
 */
export async function compactThread(threadId: string): Promise<ChatActionState> {
  const { user } = await requireRole({ chat: ["use"] });
  const db = await getDb();

  if (isRunning(threadId)) {
    return { error: "Wait for this answer to finish, then compact." };
  }

  // Not a log: compacting rewrites what a model sees next turn, and a log has no next
  // turn — it would only be losing the record it exists to keep.
  const thread = await db.chatThread.findFirst({
    where: { id: threadId, userId: user.id, unattended: false },
    select: { model: true },
  });
  if (!thread) return { error: "No such conversation." };

  const result = await compact(db, threadId, thread.model);
  if (!result.ok) return { error: result.error };

  await revalidateWorkspacePath("/chat");
  return NO_ERROR;
}

// --- Talking to a background run, and taking its log over afterwards. -------------
//
// A budget inference runs in the worker, in another process, so none of the above
// applies to it: there is no `RunControl` to abort and no registry to find it in. What
// there is instead is the thread it logs into, which both processes can see — so saying
// something to a run is a `ChatMessage`, and stopping one is a column on the run row.
// The loop reads both between rounds (lib/server/budget/inference-log.ts).
//
// All three are gated on `chat: ["use"]` and on owning the thread, and nothing more.
// The run was started by someone who held `budget: ["update"]` at the time, and these
// only redirect, end, or carry on that same run — a person may not, through any of
// them, cause a budget to be written that the run was not already going to write.

/**
 * Say something to a run that is working: it lands in its conversation at the top of
 * the next round.
 *
 * Not a turn — nobody may take one in a log while the worker is writing it — so this is
 * an appended `user` row and nothing else. The model sees it when the run next looks;
 * the page shows it as soon as it refreshes.
 */
export async function tellRun(threadId: string, message: string): Promise<ChatActionState> {
  const { user } = await requireRole({ chat: ["use"] });
  const db = await getDb();

  const said = message.trim();
  if (!said) return { error: "Say what you want it to do." };

  const log = await ownLog(db, threadId, user.id);
  if (!log) return { error: "No such conversation." };
  if (!log.runningSince) {
    return { error: "That run has finished. Continue the conversation to carry on with it." };
  }

  await appendMessage(db, threadId, { role: "user", content: said });
  return NO_ERROR;
}

/**
 * Ask a run to stop reading and build the budget from what it has proposed so far.
 *
 * Graceful, and the only kind of stop offered: the run has spent minutes reading and
 * what it found is worth keeping, so this is the step cap arriving early rather than an
 * abandoned run. Areas it never reached are left out and named in the log — see
 * lib/server/budget/llm.ts, which deliberately does *not* fill them in deterministically
 * after a stop.
 */
export async function stopRun(threadId: string): Promise<ChatActionState> {
  const { user } = await requireRole({ chat: ["use"] });
  const db = await getDb();

  if (!(await ownLog(db, threadId, user.id))) return { error: "No such conversation." };

  const asked = await db.budgetInferenceRun.updateMany({
    where: { threadId, status: { in: ["queued", "running"] }, stopRequestedAt: null },
    data: { stopRequestedAt: new Date() },
  });
  // Nothing to stop: already asked, or already over. Neither is an error worth putting
  // in front of someone who has just pressed the button on a run that was finishing.
  if (asked.count === 0) return NO_ERROR;

  await revalidateWorkspacePath("/chat");
  return NO_ERROR;
}

/**
 * Take over a finished run's log and carry it on as an ordinary conversation.
 *
 * Clearing `unattended` is what does it: the page grows a composer, the turn route will
 * claim the thread, and compacting — which a log this size will want — starts working.
 * `continuedAt` is what keeps the record honest, marking where the worker stopped
 * writing and a person started talking; the turn tells the model the same thing, since
 * the tools that run held (`propose_items`, `finish`) are not the ones it now has.
 *
 * Refused while the run is still going, because the worker is still writing to this
 * thread and two writers on one conversation is how a thread stops being one.
 */
export async function continueLog(threadId: string): Promise<ChatActionState> {
  const { user } = await requireRole({ chat: ["use"] });
  const db = await getDb();

  const log = await ownLog(db, threadId, user.id);
  if (!log) return { error: "No such conversation." };

  // The run row, not the thread's claim, is the authority on whether the worker is
  // still there: a process killed mid-run leaves `runningSince` set forever, and a log
  // nobody can ever continue because of how the machine died is not the intent.
  const working = await db.budgetInferenceRun.findFirst({
    where: { threadId, status: { in: ["queued", "running"] } },
    select: { id: true },
  });
  if (working) {
    return { error: "This run is still working. Stop it first, or wait for it to finish." };
  }

  await db.chatThread.updateMany({
    where: { id: threadId, userId: user.id, unattended: true },
    data: { unattended: false, continuedAt: new Date(), runningSince: null },
  });

  // A `system` row, like the run's own notes: this is the app saying what happened, not
  // anything said in the conversation, and the model is never shown it.
  await appendMessage(db, threadId, {
    role: "system",
    content:
      "Taken over from here. Everything above was written by the background run; " +
      "from here it is a conversation.",
  });

  await revalidateWorkspacePath("/chat");
  return NO_ERROR;
}

/** Whether this log is this person's, and its claim. The mirror of `ownThread`:
 *  `unattended: true` is the whole point rather than the thing being excluded. */
async function ownLog(
  db: ScopedDb,
  threadId: string,
  userId: string,
): Promise<{ runningSince: Date | null } | null> {
  return db.chatThread.findFirst({
    where: { id: threadId, userId, unattended: true },
    select: { runningSince: true },
  });
}

/** Whether this thread is this person's, and a conversation rather than a log. Threads
 *  are private to their author, and the `userId` filter is the only thing that makes
 *  them so — see the note above. `unattended` is excluded because the callers are stop
 *  and steer: there is no turn of ours running in a log to stop, and nothing said into
 *  one would ever be read. Both answer "No such conversation.", which for something that
 *  is not one is true enough. */
async function ownThread(
  db: ScopedDb,
  threadId: string,
  userId: string,
): Promise<boolean> {
  const found = await db.chatThread.findFirst({
    where: { id: threadId, userId, unattended: false },
    select: { id: true },
  });
  return found !== null;
}

export async function renameThread(
  _prev: ChatActionState,
  form: FormData,
): Promise<ChatActionState> {
  const { user } = await requireRole({ chat: ["use"] });
  const db = await getDb();

  const id = text(form, "threadId");
  const title = text(form, "title");
  if (!title) return { error: "A conversation needs a name." };

  await db.chatThread.updateMany({
    where: { id, userId: user.id },
    data: { title: title.slice(0, MAX_TITLE_LENGTH) },
  });

  await revalidateWorkspacePath("/chat");
  return NO_ERROR;
}

export async function deleteThread(
  _prev: ChatActionState,
  form: FormData,
): Promise<ChatActionState> {
  const { workspace, user } = await requireRole({ chat: ["use"] });
  const db = await getDb();

  // Messages go with it: `ChatMessage.threadId` cascades.
  await db.chatThread.deleteMany({ where: { id: text(form, "threadId"), userId: user.id } });

  await revalidateWorkspacePath("/chat");
  redirect(workspacePath(workspace.slug, "/chat"));
}
