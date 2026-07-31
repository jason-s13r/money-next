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
 *
 * Both of those mechanisms — the claim, the backoff, the reaper — are the same for
 * all three queues and live in lib/server/run-queue.ts. What is left here is what
 * each queue actually *does*, which is the only part that differs.
 */
import { catalogDb, scopedDb, type ScopedDb } from "../lib/server/db";
import { akahuFor, TOKEN_LINK_SELECT } from "../lib/server/akahu";
import { runSync, type SyncLink } from "../lib/server/ingest/sync";
import { runRules } from "../lib/server/rules/engine";
import { runBudgetInference } from "../lib/server/budget/run";
import {
  claim,
  eligibleNow,
  failureText,
  finalise,
  reapStale,
} from "../lib/server/run-queue";

// --- Sync queue ------------------------------------------------------------

/**
 * Claim and run one queued sync for a workspace, if there is one. Returns whether
 * it did work, so the caller can keep draining until the queue is empty. Claiming
 * is `claim` (lib/server/run-queue.ts); what is here is what a sync in particular
 * does once it holds the row.
 */
async function claimAndRunSync(db: ScopedDb): Promise<boolean> {
  const eligible = eligibleNow();
  const next = await db.syncRun.findFirst({
    where: { status: "queued", ...eligible },
    orderBy: { startedAt: "asc" },
  });
  if (!next) return false;
  if (!(await claim(db.syncRun, next.id, eligible))) return false;

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
    await finalise(db.syncRun, "sync run", { id: next.id, attempts: next.attempts + 1 }, failureText(error));
  }

  return true;
}

// --- Rules queue -----------------------------------------------------------

/**
 * Claim and run one queued rules pass. The work is `runRules` over the workspace,
 * handed the claimed run's id so it finalises that row in place (success + the
 * field-change log) instead of creating its own. On the happy path `runRules`
 * writes the success; on a throw the row is still `running`, so we route it
 * through the same retry-or-fail path as every other queue.
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
  if (!(await claim(db.ruleRun, next.id, eligible))) return false;

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
    await finalise(db.ruleRun, "rule run", { id: next.id, attempts: next.attempts + 1 }, failureText(error));
  }
  return true;
}

// --- Budget inference queue ------------------------------------------------

/**
 * Claim and run one queued budget inference. On success the created (or refreshed)
 * budget's id is written back to the run, so the budgets page can point at it; on
 * a throw the row is routed through the same retry-or-fail path as the others.
 *
 * This is the slowest queue by a wide margin — it is an LLM conversation — but the
 * reaper needs no special case for that: WORKER_STALE_MINUTES is set well above
 * any real inference, so a slow-but-alive one is never reaped out from under
 * itself and double-run.
 */
async function claimAndRunInference(db: ScopedDb): Promise<boolean> {
  const eligible = eligibleNow();
  const next = await db.budgetInferenceRun.findFirst({
    where: { status: "queued", ...eligible },
    orderBy: { startedAt: "asc" },
  });
  if (!next) return false;
  if (!(await claim(db.budgetInferenceRun, next.id, eligible))) return false;

  console.log(`\n=== budget inference (${next.workspaceId}) — ${next.budgetId ? "re-infer" : "create"} ===`);
  try {
    // `userId` is carried through for the log the run writes (a thread belongs to a
    // person), and `id` so the log can be recorded on this row while it is still going.
    const budgetId = await runBudgetInference(db, {
      id: next.id,
      budgetId: next.budgetId,
      userId: next.userId,
    });
    // updateMany, so a run the user Cleared while it was working finalises to a
    // no-op instead of throwing on the missing row. The budget it built is already
    // written either way.
    await db.budgetInferenceRun.updateMany({
      where: { id: next.id },
      data: { status: "success", finishedAt: new Date(), budgetId },
    });
    console.log(`done (budget inference #${next.id})`);
  } catch (error) {
    await finalise(db.budgetInferenceRun, "budget inference", { id: next.id, attempts: next.attempts + 1 }, failureText(error));
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
    await reapStale(db.syncRun, "sync run", "sync");
    await reapStale(db.ruleRun, "rule run", "rules run");
    await reapStale(db.budgetInferenceRun, "budget inference", "budget inference");
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
