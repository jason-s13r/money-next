/**
 * Draining the work queues: syncs, rules passes and budget inferences.
 *
 * Not an entry point — `scripts/worker.ts` runs this on a poll loop (the compose
 * `worker` service) and `scripts/ingest.ts --drain` runs it once, right after
 * queuing, for a stack with no worker in it. Both used to be the same code twice
 * or, worse, one of them doing the work a different way.
 *
 * Everything in here belongs to `money_sync`. Claiming a run, calling Akahu and
 * writing the shared catalogs are the things phase 7 took away from the web role;
 * this module is where they went, and importing it from anything under `app/`
 * would put them straight back.
 *
 * Two failure modes are handled so a run doesn't die quietly:
 *
 *   * Retries with backoff — a run that throws (a flaky Akahu call, a transient DB
 *     error, a bad rule graph) goes back to `queued` with `nextAttemptAt` pushed
 *     into the future rather than straight to `failed`, and is retried up to
 *     WORKER_MAX_ATTEMPTS times with exponential backoff before it is failed for
 *     good. A *permanent* condition — a sync's link being gone/inactive — is failed
 *     immediately; retrying it would only burn attempts.
 *
 *   * Stale-claim recovery — if the worker process itself dies between claiming a
 *     row and finishing it, the row is left `running` with no live worker on it,
 *     and the page would poll it forever. A reaper pass reclaims any `running` row
 *     older than WORKER_STALE_MINUTES (well above a real run) and routes it through
 *     the same retry-or-fail decision.
 *
 * Safe to run as one instance, and safe if two overlap: each claim is atomic
 * (queued → running guarded by a conditional update), so `pnpm worker:sync --drain`
 * on a laptop cannot take a row out from under a running worker.
 */
import { catalogDb, scopedDb, type ScopedDb } from "../lib/server/db";
import { akahuFor, TOKEN_LINK_SELECT } from "../lib/server/akahu";
import { runSync, type SyncLink } from "../lib/server/ingest/sync";
import { runRules } from "../lib/server/rules/engine";
import { runBudgetInference } from "../lib/server/budget/run";

// How many times a run may be claimed before a failure is terminal, and the base
// gap between retries (doubled each attempt) — a transient blip clears in seconds,
// a persistent one gives up rather than spinning forever on the Akahu quota.
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3);
const BACKOFF_SECONDS = Number(process.env.WORKER_BACKOFF_SECONDS ?? 30);

// A `running` row older than this has no live worker on it (the process died
// mid-run) — the reaper reclaims it. Deliberately far above any real sync so a
// slow-but-alive run is never reaped out from under itself and double-run.
const STALE_MINUTES = Number(process.env.WORKER_STALE_MINUTES ?? 15);

// A `queued` row is only claimable once any retry backoff has elapsed.
const eligibleNow = () => ({ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] });

/**
 * The retry-or-fail decision, shared by both queues. `attempts` is how many times
 * this run has been claimed (bumped at claim), so it reflects the try that just
 * ended. Below the cap the run goes back to `queued` with exponential backoff — the
 * re-queue clears `finishedAt` (it isn't over) but keeps the last `error`, so the
 * page shows *why* a pending run is being retried; at the cap it fails for good.
 * Returns the `data` to write and, for the log line, the backoff (null on fail).
 */
function nextState(attempts: number, error: string) {
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

const staleMessage = (kind: string) =>
  `The worker running this ${kind} stopped before it finished (no update for over ${STALE_MINUTES} minutes).`;

// --- Sync queue ------------------------------------------------------------

async function retryOrFailSync(db: ScopedDb, run: { id: number; attempts: number }, error: string) {
  const { data, retryMs } = nextState(run.attempts, error);
  await db.syncRun.update({ where: { id: run.id }, data });
  logOutcome("sync run", run.id, run.attempts, retryMs);
}

/**
 * Reclaim syncs left `running` by a worker that died mid-job. A `running` row whose
 * `startedAt` is older than the stale window can't have a live worker on it — the
 * claim resets `startedAt` to now and a real run finishes far inside the window —
 * so hand each back to `retryOrFailSync`. The reclaim is a guarded `updateMany`
 * (still `running`, still stale) so it can't race a legitimate finish, and it flips
 * the row to `queued` first so nothing else treats it as in-flight while we decide.
 */
async function reapStaleSyncs(db: ScopedDb): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000);
  const stale = await db.syncRun.findMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    select: { id: true, attempts: true },
  });
  for (const run of stale) {
    const won = await db.syncRun.updateMany({
      where: { id: run.id, status: "running", startedAt: { lt: cutoff } },
      data: { status: "queued" },
    });
    if (won.count === 0) continue; // finished between the read and here
    console.error(`sync run #${run.id}: stale claim (running > ${STALE_MINUTES}m), reclaiming`);
    await retryOrFailSync(db, run, staleMessage("sync"));
  }
}

/**
 * Claim and run one queued sync for a workspace, if there is one. Returns whether
 * it did work, so the caller can keep draining until the queue is empty.
 *
 * The claim is a guarded `updateMany` (queued → running, `count` tells us whether
 * we won the race): a plain read-then-write would let two workers both pick up the
 * same row. `startedAt` is reset to now on claim, so the run's duration on `/sync`
 * is execution time, not the time it sat in the queue — and, because that is what
 * the reaper measures staleness from, claiming also renews the row's lease. The
 * claim bumps `attempts`, and a run in retry backoff is skipped until its time comes.
 */
async function claimAndRunSync(db: ScopedDb): Promise<boolean> {
  const eligible = eligibleNow();
  const next = await db.syncRun.findFirst({
    where: { status: "queued", ...eligible },
    orderBy: { startedAt: "asc" },
  });
  if (!next) return false;

  const claim = await db.syncRun.updateMany({
    where: { id: next.id, status: "queued", ...eligible },
    data: { status: "running", startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claim.count === 0) return false; // another worker took it between read and write

  // The link the run was queued against. It can be gone (bank disconnected) or no
  // longer active between enqueue and now — a permanent condition, so fail it
  // outright rather than retrying, which would only burn attempts.
  const link = next.bankLinkId
    ? await db.bankLink.findFirst({
        where: { id: next.bankLinkId, status: "ACTIVE" },
        select: { ...TOKEN_LINK_SELECT, name: true, workspaceId: true },
      })
    : null;

  if (!link) {
    await db.syncRun.update({
      where: { id: next.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: "The bank link this sync was queued for is no longer active.",
      },
    });
    console.error(`sync run #${next.id}: link gone, marked failed`);
    return true;
  }

  const window = next.days ? `${next.days}d` : next.full ? "full" : "incremental";
  console.log(`\n=== ${link.name} (${link.workspaceId}) — ${window} ===`);

  try {
    // Ask Akahu to refresh the connection before ingesting, the same extra step the
    // web button used to do inline. Every sync arrives here now, scheduled ones
    // included, so this is no longer only the "sync now" path — the refresh costs
    // one call and a scheduled sync of stale data is the thing it prevents.
    //
    // Resolved from the link, not the environment (phase 8): the refresh must be
    // asked for with the same credentials the sync that follows will use, or a
    // stack with two links would refresh one person's accounts and then ingest
    // the other's.
    const akahu = akahuFor(link);
    await akahu.client.accounts.refreshAll(akahu.userToken);

    // `full` and `days` come off the row, not from this process: whoever enqueued
    // the run — a button, a cron, a person at a terminal — chose the window, and
    // the runner's job is to reproduce it.
    const counts = await runSync(link satisfies SyncLink, {
      full: next.full,
      days: next.days ?? undefined,
    });
    await db.syncRun.update({
      where: { id: next.id },
      data: { status: "success", finishedAt: new Date(), ...counts },
    });
    console.log(`done (sync run #${next.id})`);
  } catch (error) {
    // Retry with backoff, or fail for good once attempts run out. `next.attempts`
    // is the pre-claim value; the claim above bumped it, so add one to reflect the
    // try that just ended.
    await retryOrFailSync(db, { id: next.id, attempts: next.attempts + 1 }, error instanceof Error ? error.message : String(error));
  }

  return true;
}

// --- Rules queue -----------------------------------------------------------

async function retryOrFailRule(db: ScopedDb, run: { id: string; attempts: number }, error: string) {
  const { data, retryMs } = nextState(run.attempts, error);
  await db.ruleRun.update({ where: { id: run.id }, data });
  logOutcome("rule run", run.id, run.attempts, retryMs);
}

/** Stale-claim recovery for the rules queue — the `SyncRun` reaper's twin. */
async function reapStaleRules(db: ScopedDb): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000);
  const stale = await db.ruleRun.findMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    select: { id: true, attempts: true },
  });
  for (const run of stale) {
    const won = await db.ruleRun.updateMany({
      where: { id: run.id, status: "running", startedAt: { lt: cutoff } },
      data: { status: "queued" },
    });
    if (won.count === 0) continue;
    console.error(`rule run #${run.id}: stale claim (running > ${STALE_MINUTES}m), reclaiming`);
    await retryOrFailRule(db, run, staleMessage("rules run"));
  }
}

/**
 * Claim and run one queued rules pass. The mechanics mirror `claimAndRunSync`; the
 * work is `runRules` over the workspace, handed the claimed run's id so it finalises
 * that row in place (success + the field-change log) instead of creating its own. On
 * the happy path `runRules` writes the success; on a throw the row is still
 * `running`, so we route it through the same retry-or-fail path here.
 *
 * The row's own `trigger` is passed back in rather than assumed: these are queued by
 * "apply now" *and* by the ingest (`trigger: "sync"`), and the log should say which.
 */
async function claimAndRunRule(db: ScopedDb): Promise<boolean> {
  const eligible = eligibleNow();
  const next = await db.ruleRun.findFirst({
    where: { status: "queued", ...eligible },
    orderBy: { startedAt: "asc" },
  });
  if (!next) return false;

  const claim = await db.ruleRun.updateMany({
    where: { id: next.id, status: "queued", ...eligible },
    data: { status: "running", startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claim.count === 0) return false;

  console.log(`\n=== rules pass (${next.workspaceId}) — ${next.trigger} ===`);
  try {
    const trigger = next.trigger === "sync" ? "sync" : "manual";
    const summary = await runRules(db, { trigger, runId: next.id });
    console.log(
      `done (rule run ${next.id}) — ${summary.evaluated} evaluated, ` +
        `${summary.categorised} categorised, ${summary.merchantsSet} merchants, ` +
        `${summary.transfersLinked} transfers linked` +
        (summary.errors ? `, ${summary.errors} errored` : ""),
    );
  } catch (error) {
    await retryOrFailRule(db, { id: next.id, attempts: next.attempts + 1 }, error instanceof Error ? error.message : String(error));
  }
  return true;
}

// --- Budget inference queue ------------------------------------------------

async function retryOrFailInference(db: ScopedDb, run: { id: string; attempts: number }, error: string) {
  const { data, retryMs } = nextState(run.attempts, error);
  // updateMany, not update: a user can Clear a run mid-flight (it deletes the row),
  // and a finalise that threw on the missing row would take the whole worker tick
  // down with it. A no-op on a cleared row is exactly right.
  await db.budgetInferenceRun.updateMany({ where: { id: run.id }, data });
  logOutcome("budget inference", run.id, run.attempts, retryMs);
}

/** Stale-claim recovery for the inference queue — the `SyncRun` reaper's twin. An
 *  LLM run is slow, but WORKER_STALE_MINUTES is set well above any real run, so a
 *  slow-but-alive inference is never reaped out from under itself. */
async function reapStaleInference(db: ScopedDb): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000);
  const stale = await db.budgetInferenceRun.findMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    select: { id: true, attempts: true },
  });
  for (const run of stale) {
    const won = await db.budgetInferenceRun.updateMany({
      where: { id: run.id, status: "running", startedAt: { lt: cutoff } },
      data: { status: "queued" },
    });
    if (won.count === 0) continue;
    console.error(`budget inference #${run.id}: stale claim (running > ${STALE_MINUTES}m), reclaiming`);
    await retryOrFailInference(db, run, staleMessage("budget inference"));
  }
}

/**
 * Claim and run one queued budget inference. Mechanics mirror `claimAndRunSync`:
 * an atomic queued → running claim that bumps `attempts`, the slow work, then a
 * finalise. On success the created (or refreshed) budget's id is written back to the
 * run, so the budgets page can point at it; on a throw the row is routed through the
 * same retry-or-fail path as the other queues.
 */
async function claimAndRunInference(db: ScopedDb): Promise<boolean> {
  const eligible = eligibleNow();
  const next = await db.budgetInferenceRun.findFirst({
    where: { status: "queued", ...eligible },
    orderBy: { startedAt: "asc" },
  });
  if (!next) return false;

  const claim = await db.budgetInferenceRun.updateMany({
    where: { id: next.id, status: "queued", ...eligible },
    data: { status: "running", startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claim.count === 0) return false;

  console.log(`\n=== budget inference (${next.workspaceId}) — ${next.budgetId ? "re-infer" : "create"} ===`);
  try {
    const budgetId = await runBudgetInference(db, { budgetId: next.budgetId });
    // updateMany, so a run the user Cleared while it was working finalises to a
    // no-op instead of throwing on the missing row. The budget it built is already
    // written either way.
    await db.budgetInferenceRun.updateMany({
      where: { id: next.id },
      data: { status: "success", finishedAt: new Date(), budgetId },
    });
    console.log(`done (budget inference #${next.id})`);
  } catch (error) {
    await retryOrFailInference(db, { id: next.id, attempts: next.attempts + 1 }, error instanceof Error ? error.message : String(error));
  }
  return true;
}

// ---------------------------------------------------------------------------

/**
 * Drain every workspace's queues once, returning how many runs were processed.
 *
 * Which workspaces exist is control-plane data (`Workspace` is unscoped); everything
 * below runs through a client scoped to one workspace, which under RLS is also what
 * lets `money_sync` see its own rows at all — see the same note in scripts/ingest.ts.
 *
 * Syncs first, then rules, and that order is load-bearing rather than alphabetical:
 * a sync queues the rules pass that follows it, so draining syncs first means the
 * pass it queued is picked up by this same call instead of waiting for the next poll.
 *
 * `workspaceIds` narrows it, for `worker:sync --workspace <slug> --drain`: someone
 * draining the queue for one workspace by hand did not ask to run everybody else's
 * jobs on their laptop. The worker passes nothing and takes the lot.
 */
export async function drainOnce(workspaceIds?: string[]): Promise<number> {
  const workspaces = await catalogDb.workspace.findMany({
    where: workspaceIds ? { id: { in: workspaceIds } } : {},
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  let processed = 0;
  for (const { id: workspaceId } of workspaces) {
    const db = scopedDb(workspaceId);
    // Recover anything a dead worker (or cron) left `running` before draining, so a
    // reclaimed row is back in the queue for this same pass to pick up.
    await reapStaleSyncs(db);
    await reapStaleRules(db);
    await reapStaleInference(db);
    // Keep draining each queue until it's empty: a burst of clicks shouldn't wait a
    // whole poll interval per row.
    while (await claimAndRunSync(db)) processed++;
    while (await claimAndRunRule(db)) processed++;
    while (await claimAndRunInference(db)) processed++;
  }
  return processed;
}

/** Close the pool this module opened. Entry points own their process; this doesn't. */
export async function disconnect(): Promise<void> {
  await catalogDb.$disconnect();
}
