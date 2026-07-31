import "server-only";

import type { TurnEvent } from "./run";

// The turns running right now, in this process.
//
// A turn used to *be* its HTTP request: the loop ran inside the response stream, so the
// only way to affect it was to stop reading, and the only way to see it was to have been
// there when it started. Everything asked of a conversation — stop it, redirect it, walk
// away and come back to it — is the same missing thing, which is a handle on a turn that
// is not the request that happened to begin it.
//
// So a turn is started detached and registered here, and a request is a *subscriber* to
// it. Two consequences worth stating: a reload re-attaches to the turn already running
// rather than watching a thread go quiet, and a stop button can abort the model rather
// than politely closing its own eyes.
//
// **In-process, deliberately.** The registry is a `Map`, not a table or a queue, because
// the app is one long-lived Node process and a turn cannot outlive it either way. What a
// restart loses is the *streaming* of an in-flight turn; the messages up to that point
// are already rows, which is what `runningSince` recovers from.

/** How each subscriber hears about it. */
type Subscriber = (event: TurnEvent) => void;

/**
 * One live turn.
 *
 * `buffer` is what makes attaching late different from attaching at the start: an
 * arriving subscriber is replayed the events it has not already seen as rows. Each entry
 * remembers the seq committed *before* it was emitted, which is the whole trick — a
 * delta emitted while the thread was committed through seq 6 belongs to the message that
 * will become seq 7, so a client that has read the database through 7 must not be sent
 * it again, and one that has read through 6 must.
 */
type Run = {
  userId: string;
  subscribers: Set<Subscriber>;
  buffer: { event: TurnEvent; committed: number }[];
  committed: number;
  /** Aborted to stop the turn outright. */
  cancel: AbortController;
  /** Aborted to end the completion in flight and let the loop go round again — how a
   *  steer takes effect now rather than after the model finishes its thought. */
  step: AbortController | null;
};

/**
 * The most events kept for replay. A long turn is mostly deltas, one per token, and
 * holding all of them for a subscriber who may never arrive would be a slow leak. The
 * oldest are dropped first, which is the harmless end: what falls off has long since been
 * persisted, and a late subscriber reads those from the database.
 */
const MAX_BUFFER = 4_000;

/**
 * The most turns one user may have running at once. The thread-claim mechanism
 * serialises turns *per thread*; this is the per-user cap that stops one person
 * (a viewer holding `chat: ["use"]`) from opening many threads and exhausting
 * the shared local model. The cap is cheap to enforce because the registry is
 * already in-process.
 */
export const MAX_CONCURRENT_TURNS_PER_USER = 3;

/** Survives the module reloads dev does; a `Map` in module scope would strand a running
 *  turn behind a registry nothing can see any more. */
const runs: Map<string, Run> = ((globalThis as { __chatRuns?: Map<string, Run> }).__chatRuns ??=
  new Map());

/** Whether a turn is running here right now. Distinct from `ChatThread.runningSince`,
 *  which says a turn *was* started and may be the residue of a killed process. */
export function isRunning(threadId: string): boolean {
  return runs.has(threadId);
}

/**
 * Take one of this user's concurrency slots, or refuse.
 *
 * Reserving and starting are separate because the route has real work to do
 * between them — persisting the question, loading the catalog, resolving the
 * currency — and every one of those is an `await`. A count taken before those
 * awaits and acted on after them is not a cap: two requests that arrive together
 * both see two running, both pass, and both start. The check and the write have
 * to happen in the same synchronous step, which is what this is; the event loop
 * cannot interleave anything into it.
 *
 * The reservation *is* the run, minus its body. `isRunning` reports it, which is
 * what we want — a turn being set up is a turn running, and a second request for
 * the same thread should bounce off it. The caller owes a `startRun` or a
 * `cancelReservation`; there is no third option, and the `finally` in the route
 * is what makes sure of it.
 */
export function reserveRun(threadId: string, userId: string): boolean {
  if (runs.has(threadId)) return false;

  let mine = 0;
  for (const run of runs.values()) {
    if (run.userId === userId) mine++;
  }
  if (mine >= MAX_CONCURRENT_TURNS_PER_USER) return false;

  runs.set(threadId, {
    userId,
    subscribers: new Set(),
    buffer: [],
    committed: -1,
    cancel: new AbortController(),
    step: null,
  });
  return true;
}

/** Give a reservation back when the turn never got started — the setup between
 *  `reserveRun` and `startRun` threw, or the caller changed its mind. Safe to call
 *  once the run is under way only in the sense that nothing else should: it would
 *  orphan a live turn from the registry. The route calls it in a `finally` guarded
 *  by a flag for exactly that reason. */
export function cancelReservation(threadId: string): void {
  runs.delete(threadId);
}

/**
 * Start a turn, detached from whoever asked for it.
 *
 * `body` is run to settlement in the background; the caller gets control back at once and
 * is expected to `attach` if it wants to watch. The run is already registered — see
 * `reserveRun`, which the caller must have called — so a request that immediately
 * attaches cannot miss the window.
 */
export function startRun(
  threadId: string,
  initial: TurnEvent[],
  body: (emit: (event: TurnEvent) => void, control: RunControl) => Promise<void>,
): void {
  const run = runs.get(threadId);
  if (!run) {
    // Not defensive padding: without a reservation there is no slot, and starting
    // anyway would run a turn the cap has no record of.
    throw new Error(`startRun(${threadId}) without a reservation — call reserveRun first.`);
  }

  const emit = (event: TurnEvent) => {
    run.buffer.push({ event, committed: run.committed });
    if (run.buffer.length > MAX_BUFFER) run.buffer.shift();
    // A `message` event is the thread's high-water mark: everything after it is new to a
    // client that has read the database.
    if (event.t === "message") run.committed = event.seq;
    for (const subscriber of run.subscribers) subscriber(event);
  };

  const control: RunControl = {
    cancelled: run.cancel.signal,
    step: () => {
      run.step = new AbortController();
      return AbortSignal.any([run.cancel.signal, run.step.signal]);
    },
  };

  for (const event of initial) emit(event);

  void (async () => {
    try {
      await body(emit, control);
    } catch (error) {
      console.error("  [chat] run failed:", error);
      emit({ t: "error", message: "Something went wrong running this turn." });
    } finally {
      // Order matters: deregister before the last event, so a subscriber that reacts to
      // `done` by asking whether anything is running gets the truth.
      runs.delete(threadId);
      emit({ t: "done" });
      run.subscribers.clear();
    }
  })();
}

/** What a running turn is given to notice it should stop, or start over. */
export type RunControl = {
  /** Aborted when the turn should stop altogether. */
  cancelled: AbortSignal;
  /** A signal for one completion, aborted by a cancel *or* a steer. Called once per
   *  round of the loop; the previous round's signal is forgotten. */
  step: () => AbortSignal;
};

/**
 * Watch a turn already running, from where the caller has got to.
 *
 * `since` is the seq the subscriber has already seen — the last message on the page it
 * rendered — and the replay skips anything committed before it. Null when there is
 * nothing running, which is the caller's cue to start one.
 */
export function attach(
  threadId: string,
  since: number,
  onEvent: Subscriber,
): (() => void) | null {
  const run = runs.get(threadId);
  if (!run) return null;

  for (const entry of run.buffer) {
    if (entry.committed >= since) onEvent(entry.event);
  }

  run.subscribers.add(onEvent);
  return () => run.subscribers.delete(onEvent);
}

/**
 * Stop a turn. The loop notices between steps and mid-completion alike; what it has
 * already said is kept, because a model three tool calls deep has done work worth
 * keeping and stopping it is not the same as regretting it.
 */
export function cancelRun(threadId: string): boolean {
  const run = runs.get(threadId);
  if (!run) return false;
  run.cancel.abort();
  run.step?.abort();
  return true;
}

/**
 * End the completion in flight without ending the turn, so the loop goes round again and
 * re-reads a thread that now has something new in it.
 *
 * This is what makes steering immediate. Every round already rebuilds the conversation
 * from the database, so an instruction appended by someone watching would be obeyed
 * *eventually* — after the current answer finished, which for a model that has started
 * looping is exactly the wait nobody wants.
 */
export function steerRun(threadId: string): boolean {
  const run = runs.get(threadId);
  if (!run?.step) return false;
  run.step.abort();
  return true;
}
