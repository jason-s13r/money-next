/**
 * Queues an Akahu sync for every active bank link — the scheduled counterpart to
 * the app's "sync now" button.
 *
 *   money sync                        # incremental: since the newest stored transaction
 *   money sync --full                 # re-fetch the whole history window
 *   money sync --days 90              # explicit lookback window
 *   money sync --workspace <slug|id>  # one workspace instead of all of them
 *   money sync --watch                # stay attached and report until the runs finish
 *   money sync --drain                # run them here instead of waiting for the worker
 *
 * It queues; it does not sync. One `queued` SyncRun per active link, then it
 * stops — the worker claims them, and everything downstream (refresh, ingest,
 * retry/backoff, the rules pass) happens there, once, the same way for a cron
 * tick as for a button press. So this process never needs TOKEN_ENCRYPTION_KEY,
 * never calls Akahu, and finishes in milliseconds.
 *
 * Which means a stack with no worker syncs nothing. `--drain` is the answer for
 * one that genuinely has none (a laptop, a one-shot restore): it queues, then
 * runs the drain loop here until the queues are empty.
 *
 * Safe to re-run either way — queuing is coalesced per link, and every row the
 * ingest writes is upserted on its Akahu id.
 */

import { Command, Option } from "commander";

import { positiveInt } from "../lib/options";
import { onExit } from "../runtime";

// Bound in the action rather than imported statically — the rule in cli/program.ts.
let catalogDb: typeof import("../../lib/server/db").catalogDb;
let scopedDb: typeof import("../../lib/server/db").scopedDb;
let enqueueSync: typeof import("../../lib/server/queue").enqueueSync;

type Opts = {
  full?: boolean;
  days?: number;
  watch?: boolean;
  drain?: boolean;
  workspace?: string;
};

export function register(program: Command): void {
  program
    .command("sync")
    .description("Queue an Akahu sync for every active bank link, now")
    .option("--full", "re-fetch the whole history window instead of the recent tail")
    .option("--days <days>", "an explicit lookback window", positiveInt)
    .option("--workspace <slug|id>", "one workspace instead of all of them")
    .option("--watch", "stay attached and report until the runs finish")
    .addOption(
      new Option("--drain", "run the queue down in this process instead of waiting for the worker")
        // --drain does the work here, so by the time it returns there is nothing
        // left to watch. Accepting both would silently ignore one.
        .conflicts("watch"),
    )
    .addHelpText(
      "after",
      `
Writes one queued SyncRun per ACTIVE bank link, in every workspace, and exits —
the money_sync worker (pnpm worker:start) does the Akahu fetch, the ingest and
the rules pass that follows. Nothing syncs without a worker somewhere; use
--drain on a stack that has none. Driven by cron in the container stack.

Queuing is coalesced per link: a run already waiting is reused (widened, if this
request asks for more history) rather than stacked, so a cron tick while the
worker is down doesn't build up a backlog of identical jobs.
`,
    )
    .action(run);
}

/** A queued run, and enough about it to narrate what happens to it next. */
type Queued = { workspaceId: string; runId: string; link: string; existing: boolean };

/**
 * Write a queued SyncRun for every ACTIVE link in every workspace.
 *
 * Which workspaces exist is control-plane data and the one read here with no
 * workspace to scope to. Everything below goes through a scoped client, which
 * under RLS is also what lets the sync role touch these rows at all.
 *
 * The link select is `id` and `name` — no ciphertext. An enqueuer has no use for
 * a token and no key to open one, so none passes through this process.
 */
async function queueSyncs(opts: Opts): Promise<Queued[]> {
  const workspaces = await catalogDb.workspace.findMany({
    where: opts.workspace ? { OR: [{ slug: opts.workspace }, { id: opts.workspace }] } : {},
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  if (opts.workspace && workspaces.length === 0) {
    throw new Error(
      `No workspace with slug or id "${opts.workspace}". See: money workspace list`,
    );
  }

  const queued: Queued[] = [];

  for (const { id: workspaceId } of workspaces) {
    const db = scopedDb(workspaceId);
    const links = await db.bankLink.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { createdAt: "asc" },
    });

    for (const link of links) {
      const { id, existing } = await enqueueSync(db, {
        bankLinkId: link.id,
        full: opts.full,
        days: opts.days,
      });
      queued.push({ workspaceId, runId: id, link: link.name, existing });
      const what = existing ? "already queued" : "queued";
      console.log(`${what}: sync run #${id} — ${link.name} (${workspaceId})`);
    }
  }

  return queued;
}

// --- --watch ---------------------------------------------------------------

const WATCH_POLL_SECONDS = Number(process.env.SYNC_WATCH_POLL_SECONDS ?? 2);
/** How long everything may sit untouched before we suspect nothing is draining. */
const NUDGE_SECONDS = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TERMINAL = new Set(["success", "failed"]);

/** What a run looks like from the outside, whichever queue it is in. */
type Watched = { key: string; status: string; attempts: number; detail: string };

/**
 * Follow the queued runs until they are done, printing each transition.
 *
 * Two things: the sync runs just queued, by id, and any rules pass queued or
 * running in those workspaces — a sync queues one behind itself, and finishing
 * before it has run would report a job half done.
 *
 * Read-only. Ctrl-C leaves the queue as it is and the worker carries on; this is
 * a viewer, not a lease. Returns the failed count, for the exit code.
 */
async function watch(queued: Queued[]): Promise<number> {
  const workspaces = [...new Set(queued.map((q) => q.workspaceId))];
  const ids = queued.map((q) => q.runId);
  const seen = new Map<string, string>();
  // Found by *state*, since the pass being waited for does not exist yet when
  // this starts. Once seen, a run is followed by id — dropping out of
  // queued/running is exactly the transition worth reporting.
  const ruleIds = new Set<string>();
  let failures = 0;
  let lastChange = Date.now();
  let nudged = false;

  console.log(`\nWatching ${ids.length} sync run(s) — Ctrl-C to stop watching (the queue is unaffected).`);

  for (;;) {
    const runs: Watched[] = [];

    for (const workspaceId of workspaces) {
      const db = scopedDb(workspaceId);

      for (const run of await db.syncRun.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, status: true, attempts: true, error: true,
          accountsSynced: true, transactionsSynced: true, nextAttemptAt: true,
        },
      })) {
        runs.push({
          key: `sync run #${run.id}`,
          status: run.status,
          attempts: run.attempts,
          detail:
            run.status === "success"
              ? `${run.accountsSynced} account(s), ${run.transactionsSynced} transaction(s)`
              : run.status === "failed"
                ? (run.error ?? "no reason recorded")
                : run.status === "queued" && run.nextAttemptAt && run.nextAttemptAt > new Date()
                  ? `retrying at ${run.nextAttemptAt.toLocaleTimeString()}${run.error ? ` — ${run.error}` : ""}`
                  : "",
        });
      }

      for (const run of await db.ruleRun.findMany({
        where: {
          OR: [{ status: { in: ["queued", "running"] } }, { id: { in: [...ruleIds] } }],
        },
        select: {
          id: true, status: true, attempts: true, trigger: true, error: true,
          evaluated: true, categorised: true, merchantsSet: true, transfersLinked: true,
        },
      })) {
        ruleIds.add(run.id);
        runs.push({
          key: `rule run ${run.id}`,
          status: run.status,
          attempts: run.attempts,
          detail:
            run.status === "success"
              ? `${run.evaluated} evaluated, ${run.categorised} categorised, ` +
                `${run.merchantsSet} merchants, ${run.transfersLinked} transfers linked`
              : run.status === "failed"
                ? (run.error ?? "no reason recorded")
                : run.trigger,
        });
      }
    }

    for (const run of runs) {
      // `attempts` is in the key so a re-queue after a failed try prints again
      // rather than looking like the row never moved.
      const state = `${run.status}/${run.attempts}`;
      if (seen.get(run.key) === state) continue;
      seen.set(run.key, state);
      lastChange = Date.now();
      nudged = false;
      console.log(`  ${run.key}: ${run.status}${run.detail ? ` — ${run.detail}` : ""}`);
      if (run.status === "failed") failures++;
    }

    if (runs.every((r) => TERMINAL.has(r.status))) return failures;

    // A queue that never moves usually means nobody is draining it. Said once,
    // rather than spinning silently until the operator gives up.
    if (!nudged && Date.now() - lastChange > NUDGE_SECONDS * 1000) {
      nudged = true;
      console.log(
        `  …nothing has moved in ${NUDGE_SECONDS}s. Is the worker running? ` +
          "(`pnpm worker:start`, or re-run with --drain to do the work here.)",
      );
    }

    await sleep(WATCH_POLL_SECONDS * 1000);
  }
}

// ---------------------------------------------------------------------------

async function run(opts: Opts) {
  ({ catalogDb, scopedDb } = await import("../../lib/server/db"));
  ({ enqueueSync } = await import("../../lib/server/queue"));
  onExit(() => catalogDb?.$disconnect());

  const queued = await queueSyncs(opts);

  if (queued.length === 0) {
    const where = opts.workspace ? ` in "${opts.workspace}"` : "";
    console.log(`no active bank links${where} — nothing to queue`);
    return;
  }

  if (opts.drain) {
    // Imported here: this is the branch that pulls in the ingest pipeline and
    // the rules engine's native addon, and the cron path loads neither. From
    // scripts/ because the drain loop is the worker's — copying it here would
    // reimplement the thing this command exists not to reimplement.
    const { drainOnce } = await import("../../scripts/drain");
    // Only the workspaces just queued for: someone draining one workspace by
    // hand did not volunteer to run every other workspace's jobs here.
    const processed = await drainOnce([...new Set(queued.map((q) => q.workspaceId))]);
    console.log(processed === 0 ? "\nqueue empty" : `\ndrained ${processed} run(s)`);
    return;
  }

  if (opts.watch) {
    const failures = await watch(queued);
    if (failures > 0) {
      console.error(`\n${failures} run(s) failed`);
      process.exitCode = 1;
    } else {
      console.log("\nall done");
    }
    return;
  }

  const fresh = queued.filter((q) => !q.existing).length;
  console.log(
    `\n${fresh} run(s) queued, ${queued.length - fresh} already waiting. ` +
      "The worker will pick them up; --watch to follow along.",
  );
}
