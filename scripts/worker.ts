/**
 * Drains queued syncs.
 *
 *   pnpm db:worker            # poll the queue forever (the compose `worker` service)
 *   pnpm db:worker --once     # drain what's queued now, then exit (tests / cron-style)
 *
 * Phase 7 split the sync in two. The web app (`money_app`) no longer runs the
 * ingest in-request — it writes a `SyncRun` in the `queued` state and returns.
 * This worker (`money_sync`) is what actually does the work: it claims queued
 * rows, runs the Akahu refresh + ingest, and finalises them. That is why the web
 * role needs neither catalog write access nor the Akahu rate limit.
 *
 * Short-poll, not LISTEN/NOTIFY: a self-host wants the simplest thing that makes a
 * user-triggered sync feel prompt, and a few seconds' latency is fine. The cron
 * container still runs the *scheduled* sync (`pnpm db:sync`) on its own timer;
 * this only reacts to what a person queued.
 *
 * Safe to run as one instance. The claim is atomic (queued → running guarded by a
 * conditional update), so even two workers can't both take the same row, but the
 * compose stack runs exactly one.
 */
import { catalogDb, scopedDb, type ScopedDb } from "../lib/server/db";
import { akahuClient, akahuUserToken } from "../lib/server/akahu";
import { runSync, type SyncLink } from "../lib/server/ingest/sync";

const POLL_SECONDS = Number(process.env.WORKER_POLL_SECONDS ?? 5);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Claim and run one queued row for a workspace, if there is one. Returns whether
 * it did work, so the caller can keep draining until the queue is empty before it
 * sleeps.
 *
 * The claim is a guarded `updateMany` (queued → running, `count` tells us whether
 * we won the race): a plain read-then-write would let two workers both pick up the
 * same row. `startedAt` is reset to now on claim, so the run's duration on `/sync`
 * is execution time, not the time it sat in the queue.
 */
async function claimAndRun(db: ScopedDb): Promise<boolean> {
  const next = await db.syncRun.findFirst({
    where: { status: "queued" },
    orderBy: { startedAt: "asc" },
  });
  if (!next) return false;

  const claim = await db.syncRun.updateMany({
    where: { id: next.id, status: "queued" },
    data: { status: "running", startedAt: new Date() },
  });
  if (claim.count === 0) return false; // another worker took it between read and write

  // The link the run was queued against. It can be gone (bank disconnected) or no
  // longer active between enqueue and now — treat that as a failed run, not a crash.
  const link = next.bankLinkId
    ? await db.bankLink.findFirst({
        where: { id: next.bankLinkId, status: "ACTIVE" },
        select: { id: true, name: true, workspaceId: true },
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

  console.log(`\n=== ${link.name} (${link.workspaceId}) — ${next.full ? "full" : "incremental"} ===`);

  try {
    // Ask Akahu to refresh the connection before ingesting, the same extra step the
    // web button used to do inline. The cron's scheduled sync does not — it runs
    // often enough to rely on Akahu's own refresh cadence — but a person clicking
    // "sync now" wants the freshest data Akahu can give.
    const akahu = akahuClient();
    await akahu.accounts.refreshAll(akahuUserToken());

    const counts = await runSync(link as SyncLink, { full: next.full });
    await db.syncRun.update({
      where: { id: next.id },
      data: { status: "success", finishedAt: new Date(), ...counts },
    });
    console.log(`done (sync run #${next.id})`);
  } catch (error) {
    // Record the failure so a queued sync that keeps dying is visible on `/sync`
    // rather than only in this process's logs.
    await db.syncRun.update({
      where: { id: next.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    console.error(`sync run #${next.id} failed:`, error);
  }

  return true;
}

/**
 * Drain every workspace's queue once. Which workspaces exist is control-plane data
 * (`Workspace` is unscoped); everything below runs through a client scoped to one
 * workspace, which under RLS is also what lets `money_sync` see its `SyncRun` rows
 * at all — see the same note in scripts/ingest.ts.
 */
async function drainOnce(): Promise<number> {
  const workspaces = await catalogDb.workspace.findMany({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  let processed = 0;
  for (const { id: workspaceId } of workspaces) {
    const db = scopedDb(workspaceId);
    // Keep draining this workspace until its queue is empty: a coalesced click plus
    // an upgrade could leave more than one waiting, and a burst shouldn't wait a
    // whole poll interval per row.
    while (await claimAndRun(db)) processed++;
  }
  return processed;
}

async function main() {
  const once = process.argv.includes("--once");

  if (once) {
    const processed = await drainOnce();
    console.log(processed === 0 ? "queue empty" : `drained ${processed} run(s)`);
    await catalogDb.$disconnect();
    return;
  }

  console.log(`sync worker up — polling every ${POLL_SECONDS}s`);
  // Loop forever. The compose service restarts us on crash; a caught per-run error
  // above already keeps one bad job from taking the loop down.
  for (;;) {
    try {
      await drainOnce();
    } catch (error) {
      // A failure *outside* a claimed run (e.g. the workspace enumeration) — log and
      // keep polling rather than exiting the container.
      console.error("worker tick failed:", error);
    }
    await sleep(POLL_SECONDS * 1000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
