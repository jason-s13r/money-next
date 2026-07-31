import type { NextRequest } from "next/server";

import { ForbiddenError, requireRole } from "@/lib/server/auth/session";
import { languageModel } from "@/lib/server/chat/client";
import { runTurn, type TurnEvent } from "@/lib/server/chat/run";
import {
  attach,
  cancelReservation,
  isRunning,
  reserveRun,
  startRun,
  MAX_CONCURRENT_TURNS_PER_USER,
} from "@/lib/server/chat/runs";
import { appendMessage } from "@/lib/server/chat/thread";
import {
  CHAT_TOOLS,
  lazyFx,
  lazyHistory,
  loadCatalog,
  type ToolContext,
} from "@/lib/server/chat/tools";
import { getDb } from "@/lib/server/db/request";
import type { ScopedDb } from "@/lib/server/db";
import { titleFrom } from "@/lib/chat/messages";

// A view of one turn of a chat, streamed.
//
// The only route handler in this app besides Better Auth's, and it is one for a
// reason: server actions are dispatched one at a time per client and return a single
// response, which is the wrong shape for something that emits for a minute. The docs
// say as much — "use a Route Handler for non-mutation requests".
//
// **It lives under `/w/[workspace]/` and must.** `proxy.ts` derives the workspace slug
// from the path and puts it in a header, which is the only thing `requireWorkspace()`
// has to go on; a handler at `/api/chat` would resolve no workspace and 404.
//
// **Everything that can fail happens before the first byte.** Once a stream is open
// the status line and headers are already sent, so a 404 or a redirect after that
// point degrades into something the browser has to be talked into — the streaming
// guide is explicit about it. Auth, ownership, the claim and the user message are all
// resolved up front, and only then is the `ReadableStream` constructed.
//
// **This request no longer *is* the turn.** It starts one if none is running and then
// subscribes to it either way (lib/server/chat/runs.ts). So the same endpoint serves
// asking a question and walking back in on the answer, and closing the response has no
// opinion about whether the model should stop — `stopTurn` is how you say that.

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/w/[workspace]/chat/[thread]/turn">,
) {
  // Membership, and separately whether this person may change anything. `requireRole`
  // throws rather than returning false, and a viewer holding a read-only conversation
  // is a supported state, not an error — so the write permission is probed, not
  // required.
  const { user } = await requireRole({ chat: ["use"] });
  // The two write grants the tools distinguish, probed rather than required: a viewer
  // holding a read-only conversation is a supported state, and so is a member who may
  // recategorise a transaction but not rewrite the household's budget. `requireRole`
  // throws rather than returning false, hence `may`.
  const can = {
    budget: await may({ budget: ["update"] }),
    enrichment: await may({ enrichment: ["update"] }),
  };

  const { thread: threadId } = await ctx.params;
  const db = await getDb();

  let body: { message?: unknown; since?: unknown; attach?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  // How far the caller has already read the thread from the database, so a replay does
  // not hand it a second copy of what is already on its screen.
  const since = typeof body.since === "number" ? body.since : -1;
  // "Watch whatever is happening, but do not make anything happen." What a page says on
  // arrival. Without it, a reload that lands in the moment between a turn's last message
  // and its deregistration would start a second turn on a finished conversation — the
  // race is small and the result is the model answering itself.
  const watchOnly = body.attach === true;

  // Already running here: subscribe rather than refuse. This is the reload case, the
  // second-tab case, and the "I closed it and came back" case, which used to be three
  // ways of being told the conversation was busy.
  if (isRunning(threadId)) {
    const owned = await db.chatThread.findFirst({
      where: { id: threadId, userId: user.id },
      select: { id: true },
    });
    if (!owned) return Response.json({ error: "No such conversation." }, { status: 404 });
    if (message) {
      return Response.json(
        { error: "This conversation is already working. Steer it instead." },
        { status: 409 },
      );
    }
    return streamOf(threadId, since);
  }

  if (watchOnly) {
    const owned = await db.chatThread.findFirst({
      where: { id: threadId, userId: user.id },
      select: { id: true },
    });
    if (!owned) return Response.json({ error: "No such conversation." }, { status: 404 });
    // Nothing to watch. A stream that says `done` and closes, rather than a 404 or an
    // error, because "the turn you were following has finished" is not a failure and the
    // client already knows what `done` means.
    return streamOf(threadId, since);
  }

  // The ownership check and the claim are one statement, deliberately: checking then
  // claiming would leave a window in which a second tab claims it in between. The
  // `userId` in the filter is what makes a thread private — `scopedDb` and the RLS
  // policy under it both key on the workspace, so neither of them keeps out the other
  // member of a household. This is the one place outside lib/server/queries/chat.ts
  // that may spell it out, and it is spelled out.
  //
  // Nothing is running here, so there is nothing to lose a race with, and the claim is
  // unconditional. It used to refuse a `runningSince` newer than `LLM_TIMEOUT`, which
  // was the only guard there was; now the registry above is the truth about what is
  // running, and a claim with no run behind it is the residue of a killed process —
  // something to take over, not to wait five minutes out.
  //
  // `unattended: false` is the hard gate on a log. A log ends on whatever the worker last
  // wrote — often a `tool` row, which is exactly the shape a conversation auto-resumes
  // from — so a stale tab or a hand-rolled POST must be refused here rather than trusted
  // not to arrive. Claiming one would also fight the worker for `runningSince` while it is
  // still writing. A log that has been taken over (`continueLog`) is no longer unattended
  // and passes this like any other thread, which is the whole mechanism of a takeover.
  const claim = await db.chatThread.updateMany({
    where: { id: threadId, userId: user.id, unattended: false },
    data: { runningSince: new Date() },
  });

  if (claim.count === 0) {
    // Only reached when the claim failed, so the extra read costs nothing in the normal
    // case, and it is the difference between "that is not yours" and "that is not a
    // conversation".
    const log = await db.chatThread.findFirst({
      where: { id: threadId, userId: user.id, unattended: true },
      select: { id: true },
    });
    if (log) {
      return Response.json(
        {
          error:
            "This is a log of a background run. Wait for it to finish, then take it over " +
            "to carry it on.",
        },
        { status: 409 },
      );
    }
    return Response.json({ error: "No such conversation." }, { status: 404 });
  }

  // Read after the claim, not before: the claim is what proves the thread is this
  // person's, and reading first would be a second query saying the same thing less
  // safely. Null means whatever `LLM_MODEL` is, which is every thread that has never
  // been asked the question.
  const chosen = await db.chatThread.findFirst({
    where: { id: threadId },
    select: { model: true },
  });

  if (!languageModel()) {
    await release(db, threadId);
    return Response.json(
      { error: "No model is configured. Set LLM_API to a local endpoint." },
      { status: 503 },
    );
  }

  // Per-user concurrency cap: the thread-claim serialises turns per thread, but a
  // viewer opening several threads at once can still exhaust the shared local
  // model. Taken here, before any of the setup below, because the reservation and
  // the count that justifies it have to happen in one synchronous step — see
  // `reserveRun`. Everything from here to `startRun` is the reservation's, which
  // is what the `finally` is for: the claim on the thread and the slot in the
  // registry are two locks, and a path out of this function that drops one but not
  // the other leaves a conversation nobody can send to.
  if (!reserveRun(threadId, user.id)) {
    await release(db, threadId);
    return Response.json(
      {
        error: `You already have ${MAX_CONCURRENT_TURNS_PER_USER} conversations running. Wait for one to finish.`,
      },
      { status: 429 },
    );
  }

  let started = false;
  try {
    // Persisted before the stream opens, so a turn that dies mid-flight still leaves the
    // question in the thread rather than losing what was asked.
    const events: TurnEvent[] = [];
    if (message) {
      const row = await appendMessage(db, threadId, { role: "user", content: message });
      events.push({ t: "message", id: row.id, seq: row.seq, role: "user" });
      if (row.seq === 0) {
        const title = titleFrom(message);
        await db.chatThread.updateMany({ where: { id: threadId }, data: { title } });
        events.push({ t: "title", title });
      }
    }

    // One accessor, awaited once here for the currency name and cached for whatever the
    // tools go on to convert — see `lazyFx`.
    const fx = lazyFx(db);
    const { currency } = await fx();
    const toolContext: ToolContext = {
      db,
      now: new Date(),
      currency,
      fx,
      catalog: await loadCatalog(db),
      // Lazy: most turns never mention a transaction, and three years of history is not
      // a thing to read in order to answer "rename that item".
      history: lazyHistory(db, new Date()),
      can,
      // Captured here, while there is still a request to read a session from: the turn
      // below is detached and outlives it, and every enrichment edit it makes is logged
      // against this person.
      actorUserId: user.id,
    };

    // Detached: the turn belongs to the thread now, not to this request. Everything it
    // needs was resolved above, while there was still a request to resolve it from.
    startRun(threadId, events, async (emit, control) => {
      try {
        await runTurn({
          db,
          threadId,
          ctx: toolContext,
          tools: CHAT_TOOLS,
          emit,
          control,
          ...(chosen?.model ? { modelId: chosen.model } : {}),
        });
      } finally {
        // Always: a thread whose claim outlives the turn is a thread the composer
        // refuses to send to.
        await release(db, threadId);
      }
    });
    started = true;
  } finally {
    // Only when the setup above threw. Past `startRun` the run owns both the slot
    // and the claim, and releasing either here would cut a live turn loose.
    if (!started) {
      cancelReservation(threadId);
      await release(db, threadId);
    }
  }

  return streamOf(threadId, since);
}

/**
 * The response: a subscription to the turn running on a thread, as newline-delimited
 * JSON, replayed from `since`.
 *
 * Closing the response unsubscribes and nothing more — the turn is not this request's to
 * end. A turn that has already finished by the time this runs streams a single `done`,
 * which is the truthful answer and one the client already knows how to handle.
 */
function streamOf(threadId: string, since: number): Response {
  const encoder = new TextEncoder();
  let detach: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;

      const close = () => {
        if (!open) return;
        open = false;
        detach?.();
        detach = null;
        try {
          controller.close();
        } catch {
          // Already closed by the other path; nothing to do.
        }
      };

      const emit = (event: TurnEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The browser went away. The turn carries on — see runTurn's note — but
          // there is nobody left to tell.
          close();
          return;
        }
        if (event.t === "done") close();
      };

      detach = attach(threadId, since, emit);
      if (!detach) emit({ t: "done" });
    },

    cancel() {
      // The reader let go — a closed tab, a navigation. Unsubscribe; the turn carries on.
      detach?.();
      detach = null;
    },
  });

  return new Response(stream, {
    headers: {
      // Newline-delimited JSON rather than SSE: the client is a `fetch` reader, not an
      // `EventSource` (which cannot POST a body), so SSE's framing would be ceremony.
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      // Nginx and friends buffer a proxied response by default, which turns a stream
      // back into one big reply at the end.
      "X-Accel-Buffering": "no",
    },
  });
}

/** Clear the claim. Swallows its own failure: this runs in a `finally`, and throwing
 *  here would replace whatever actually went wrong with a database error. */
async function release(
  db: ScopedDb,
  threadId: string,
): Promise<void> {
  try {
    await db.chatThread.updateMany({
      where: { id: threadId },
      // `updatedAt` is `@updatedAt`, so this touch is also what floats a thread to
      // the top of the list when its turn finishes.
      data: { runningSince: null },
    });
  } catch (error) {
    console.error("  [chat] could not release thread claim:", error);
  }
}

/** Whether the caller holds a permission, as a boolean rather than an exception. */
async function may(permissions: Parameters<typeof requireRole>[0]): Promise<boolean> {
  try {
    await requireRole(permissions);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}
