// The run-queue protocol: claiming a job, giving it back when it fails, and
// reclaiming one whose worker died holding it.
//
// The counterpart to ./queue.ts, which is the same three tables from the
// *enqueuing* side. `SyncRun`, `RuleRun` and `BudgetInferenceRun` are queues with
// identical mechanics — claim a row atomically, do slow work outside any
// transaction, finalise it — and only the slow work differs. That part was
// written out three times in scripts/drain.ts, which is not merely repetitive: it
// is a concurrency protocol, so each copy was somewhere the guard conditions could
// drift, and one of them already had (see `finalise`).
//
// Here rather than in the script because it is the *rules* of the queue, not the
// draining of it, and because rules worth stating once are worth testing once:
// scripts/drain.ts cannot be imported without a database, and none of this needs
// one. The three run tables are structurally identical in the statements the
// protocol issues, so a plain interface is enough to talk to any of them — no
// generics over Prisma's model types, no casts, and a fake in a test is a few
// lines. Each queue's own `findFirst` stays with its own code, fully typed.
//
// No `import "server-only"`: this runs in the worker, which is plain Node.

// How many times a run may be claimed before a failure is terminal, and the base
// gap between retries (doubled each attempt) — a transient blip clears in seconds,
// a persistent one gives up rather than spinning forever on the Akahu quota.
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3);
const BACKOFF_SECONDS = Number(process.env.WORKER_BACKOFF_SECONDS ?? 30);

// A `running` row older than this has no live worker on it (the process died
// mid-run) — the reaper reclaims it. Deliberately far above any real sync so a
// slow-but-alive run is never reaped out from under itself and double-run.
const STALE_MINUTES = Number(process.env.WORKER_STALE_MINUTES ?? 15);

/** A run row, as much of one as the protocol itself cares about. */
export type QueuedRun = { id: string | number; attempts: number };

/** The statements the protocol issues against a run table. Prisma's generated
 *  delegates satisfy this structurally; nothing here is cast. */
export type RunTable = {
  findMany(args: {
    where: Record<string, unknown>;
    select: { id: true; attempts: true };
  }): Promise<QueuedRun[]>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
};

/** A `queued` row is only claimable once any retry backoff has elapsed. */
export const eligibleNow = () => ({
  OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
});

/**
 * The retry-or-fail decision. `attempts` is how many times this run has been
 * claimed (bumped at claim), so it reflects the try that just ended. Below the cap
 * the run goes back to `queued` with exponential backoff — the re-queue clears
 * `finishedAt` (it isn't over) but keeps the last `error`, so the page shows *why*
 * a pending run is being retried; at the cap it fails for good. Returns the `data`
 * to write and, for the log line, the backoff (null on fail).
 */
export function nextState(attempts: number, error: string) {
  if (attempts < MAX_ATTEMPTS) {
    const backoffMs = BACKOFF_SECONDS * 1000 * 2 ** (attempts - 1);
    return {
      data: { status: "queued", nextAttemptAt: new Date(Date.now() + backoffMs), finishedAt: null, error },
      retryMs: backoffMs,
    };
  }
  return { data: { status: "failed" as const, finishedAt: new Date(), error }, retryMs: null };
}

function logOutcome(label: string, id: string | number, attempts: number, retryMs: number | null) {
  if (retryMs === null) console.error(`${label} #${id} failed for good after ${attempts} attempts`);
  else console.error(`${label} #${id} failed (attempt ${attempts}/${MAX_ATTEMPTS}), retrying in ${Math.round(retryMs / 1000)}s`);
}

export const staleMessage = (kind: string) =>
  `The worker running this ${kind} stopped before it finished (no update for over ${STALE_MINUTES} minutes).`;

/**
 * Write the outcome of a failed run: back to `queued` with backoff, or `failed`
 * for good once the attempts are spent (see `nextState`).
 *
 * `updateMany` rather than `update`, for every queue. A user can Clear a budget
 * inference mid-flight — it deletes the row — and an `update` finalising onto a
 * missing row throws, which would take down the whole worker tick and every other
 * queue's work with it. That was already understood for inferences and written
 * only there; the other two were one "clear this run" button away from the same
 * crash. A no-op on a row that is gone is the right answer for all three, so it is
 * the only answer here.
 */
export async function finalise(
  table: RunTable,
  label: string,
  run: QueuedRun,
  error: string,
): Promise<void> {
  const { data, retryMs } = nextState(run.attempts, error);
  await table.updateMany({ where: { id: run.id }, data });
  logOutcome(label, run.id, run.attempts, retryMs);
}

/**
 * Reclaim runs left `running` by a worker that died mid-job. A `running` row whose
 * `startedAt` is older than the stale window can't have a live worker on it — the
 * claim resets `startedAt` to now and a real run finishes far inside the window —
 * so hand each to the retry-or-fail decision. The reclaim is a guarded
 * `updateMany` (still `running`, still stale) so it can't race a legitimate
 * finish, and it flips the row to `queued` first so nothing else treats it as
 * in-flight while we decide.
 */
export async function reapStale(table: RunTable, label: string, kind: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000);
  const stale = await table.findMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    select: { id: true, attempts: true },
  });
  for (const run of stale) {
    const won = await table.updateMany({
      where: { id: run.id, status: "running", startedAt: { lt: cutoff } },
      data: { status: "queued" },
    });
    if (won.count === 0) continue; // finished between the read and here
    console.error(`${label} #${run.id}: stale claim (running > ${STALE_MINUTES}m), reclaiming`);
    await finalise(table, label, run, staleMessage(kind));
  }
}

/**
 * Take a queued row for this worker, or say someone else got there first.
 *
 * A guarded `updateMany` (queued → running, `count` tells us whether we won the
 * race): a plain read-then-write would let two workers both pick up the same row,
 * and "safe if two overlap" rests entirely on this being one statement.
 * `startedAt` is reset to now, so a run's duration on `/sync` is execution time
 * rather than time spent queued — and, because that is what `reapStale` measures
 * from, claiming also renews the row's lease. The `eligible` clause is repeated
 * from the caller's read so a row whose backoff expired in between is still only
 * claimed once.
 */
export async function claim(
  table: RunTable,
  id: string | number,
  eligible: Record<string, unknown>,
): Promise<boolean> {
  const won = await table.updateMany({
    where: { id, status: "queued", ...eligible },
    data: { status: "running", startedAt: new Date(), attempts: { increment: 1 } },
  });
  return won.count > 0;
}

/** The message to finalise a thrown run with. */
export const failureText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
