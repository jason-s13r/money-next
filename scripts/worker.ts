/**
 * Drains the two work queues — syncs and rules passes — forever.
 *
 *   pnpm worker:start            # poll the queues forever (the compose `worker` service)
 *   pnpm worker:start --once     # drain what's queued now, then exit (tests / cron-style)
 *
 * Phase 7 moved work off the request. The web app (`money_app`) no longer runs the
 * ingest or a whole-workspace rules pass in-request — it writes a `SyncRun` or a
 * `RuleRun` in the `queued` state and returns. This worker (`money_sync`) is what
 * actually does the work. Since `money sync` became an enqueuer too, this is the
 * *only* process that calls Akahu or decrypts a stored token: scheduled syncs and
 * on-demand ones now arrive by the same road.
 *
 * The queue machinery itself is ./drain, shared with `money sync --drain`. What
 * is left here is the loop and the process: poll, drain, sleep.
 *
 * Short-poll, not LISTEN/NOTIFY: a self-host wants the simplest thing that makes a
 * user-triggered job feel prompt, and a few seconds' latency is fine.
 *
 * Safe to run as one instance, and the compose stack runs exactly one — though
 * nothing breaks if a second drainer overlaps, since every claim is atomic.
 */

// Bound in `main`, after the `--help` check: ./drain pulls in lib/server/db,
// which throws at module scope without DATABASE_URL, so a static import would
// make `--help` fail on the machine whose operator is reading it.
let drain: typeof import("./drain");

// Every import here is dynamic, and a file with no static import or export is
// not a module — its `const`s would land in the global scope.
export {};

const POLL_SECONDS = Number(process.env.WORKER_POLL_SECONDS ?? 5);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const USAGE = `Usage:
  pnpm worker:start            poll forever, draining queued runs as they arrive
  pnpm worker:start --once     drain whatever is queued now, then exit

Claims the SyncRun and RuleRun rows everything else enqueues — the app's "sync
now" and "apply now" buttons, the scheduled \`money sync\`, and the rules pass
an ingest queues behind itself. This is the only process that calls Akahu or
decrypts a stored token, so the web role needs neither. Also reaps runs whose
worker died mid-job. Tuned by WORKER_POLL_SECONDS, WORKER_MAX_ATTEMPTS,
WORKER_BACKOFF_SECONDS and WORKER_STALE_MINUTES.`;

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  drain = await import("./drain");

  if (process.argv.includes("--once")) {
    const processed = await drain.drainOnce();
    console.log(processed === 0 ? "queue empty" : `drained ${processed} run(s)`);
    await drain.disconnect();
    return;
  }

  console.log(`sync worker up — polling every ${POLL_SECONDS}s`);
  // Loop forever. The compose service restarts us on crash; a caught per-run error
  // inside `drainOnce` already keeps one bad job from taking the loop down.
  for (;;) {
    try {
      await drain.drainOnce();
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
