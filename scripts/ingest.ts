/**
 * Queues an Akahu sync for every active bank link — the scheduled counterpart to
 * the app's "sync now" button.
 *
 *   pnpm worker:sync                        # incremental: since the newest stored transaction
 *   pnpm worker:sync --full                 # re-fetch the whole history window
 *   pnpm worker:sync --days 90              # explicit lookback window
 *   pnpm worker:sync --workspace <slug|id>  # one workspace instead of all of them
 *   pnpm worker:sync --watch                # stay attached and report until the runs finish
 *   pnpm worker:sync --drain                # run them here instead of waiting for the worker
 *
 * ## It queues; it does not sync
 *
 * This used to do the whole ingest itself, which made it a second implementation
 * of everything the worker already did — its own SyncRun bookkeeping, no retries,
 * no stale-claim recovery, and a rules pass with different scope. Worse, it meant
 * two processes held decrypted Akahu tokens and both spent the same rate limit.
 *
 * Now it writes a `queued` SyncRun per active link and stops. `scripts/worker.ts`
 * claims them, and everything downstream — refresh, ingest, retry/backoff, the
 * rules pass the ingest queues behind itself — happens there, once, the same way
 * for a cron tick as for a button press. This process never needs
 * TOKEN_ENCRYPTION_KEY, never calls Akahu, and finishes in milliseconds.
 *
 * That does mean **a stack with no worker running syncs nothing**. `--drain` is
 * the answer for one that genuinely has no worker (a laptop, a one-shot restore):
 * it queues, then runs the drain loop in this process until the queues are empty.
 *
 * Safe to re-run either way. Queuing is coalesced per link (lib/server/queue), so
 * a cron firing while the worker is down leaves one waiting run per link rather
 * than a pile of identical ones, and every row the ingest writes is upserted on
 * its Akahu id, so a run that dies halfway can simply be run again.
 */

// Bound in `main`, after the `--help` check, rather than imported statically:
// lib/server/db throws at module scope without DATABASE_URL, so a static import
// would make `--help` fail on a machine that has not been configured — which is
// the machine whose operator is reading it. Now that the ingest pipeline is the
// worker's business rather than this script's, that pattern finally reaches here
// too; `--help` no longer needs a configured host.
let catalogDb: typeof import("../lib/server/db").catalogDb;
let scopedDb: typeof import("../lib/server/db").scopedDb;
let enqueueSync: typeof import("../lib/server/queue").enqueueSync;

// See the note in list-workspaces.ts: every import here is dynamic, and a file
// with no static import or export is not a module — its `const`s would land in
// the global scope and collide with the next script's.
export {};

type Args = {
  full: boolean;
  days?: number;
  watch: boolean;
  drain: boolean;
  workspace?: string;
};

const USAGE = `Usage:
  pnpm worker:sync                       queue an incremental sync — from the newest stored transaction
  pnpm worker:sync --full                queue a re-fetch of the whole history window
  pnpm worker:sync --days 90             queue an explicit lookback window
  pnpm worker:sync --workspace <slug|id> queue for one workspace instead of all of them
  pnpm worker:sync --watch               queue, then stay attached until the runs finish
  pnpm worker:sync --drain               queue, then run the queue down in this process

Writes one queued SyncRun per ACTIVE bank link, in every workspace, and exits —
the money_sync worker (pnpm worker:start) does the Akahu fetch, the ingest and the
rules pass that follows. Nothing syncs without a worker somewhere; use --drain on
a stack that has none. Driven by cron in the container stack.

Queuing is coalesced per link: a run already waiting is reused (widened, if this
request asks for more history) rather than stacked, so a cron tick while the
worker is down doesn't build up a backlog of identical jobs.`;

function parseArgs(argv: string[]): Args {
  const daysFlag = argv.indexOf("--days");
  const days = daysFlag !== -1 ? Number(argv[daysFlag + 1]) : undefined;
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    throw new Error(`--days expects a positive number, got: ${argv[daysFlag + 1]}`);
  }

  const workspaceFlag = argv.indexOf("--workspace");
  const workspace = workspaceFlag !== -1 ? argv[workspaceFlag + 1] : undefined;
  if (workspaceFlag !== -1 && (!workspace || workspace.startsWith("--"))) {
    throw new Error("--workspace expects a slug or id. See: pnpm workspace:list");
  }

  const args: Args = {
    full: argv.includes("--full"),
    days,
    watch: argv.includes("--watch"),
    drain: argv.includes("--drain"),
    workspace,
  };

  // Not a taste call: --drain does the work in this process, so by the time it
  // returns there is nothing left to watch. Accepting both would mean silently
  // ignoring one of them, and the operator who typed it would be waiting for
  // output that is never coming.
  if (args.watch && args.drain) {
    throw new Error("--watch and --drain do the same job two ways; pass one or the other.");
  }

  return args;
}

/** A queued run, and enough about it to narrate what happens to it next. */
type Queued = { workspaceId: string; runId: number; link: string; existing: boolean };

/**
 * Write a queued SyncRun for every ACTIVE link in every workspace.
 *
 * *Which* workspaces exist is the one question here that legitimately spans
 * tenants, and it is control-plane data — Workspace is unscoped, so this read is
 * the one with no workspace to scope to. Everything below runs through a client
 * scoped to a single workspace, which under RLS (phase 6) is also what lets the
 * sync role touch these rows at all: an unscoped read of BankLink or write of
 * SyncRun matches or permits nothing.
 *
 * The link select is `id` and `name` — no ciphertext. The enqueuer has no use for
 * a token and no key to open one with, and there is no reason for an encrypted
 * bank credential to pass through this process's memory to write a queue row.
 *
 * `--workspace` narrows the enumeration to one. Cron wants all of them; a person
 * with two workspaces on two Akahu apps, testing one of them, does not — and
 * "sync everything" is an expensive way to find out whether one link works.
 */
async function queueSyncs(args: Args): Promise<Queued[]> {
  const workspaces = await catalogDb.workspace.findMany({
    where: args.workspace ? { OR: [{ slug: args.workspace }, { id: args.workspace }] } : {},
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  if (args.workspace && workspaces.length === 0) {
    throw new Error(
      `No workspace with slug or id "${args.workspace}". See: pnpm workspace:list`,
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
        full: args.full,
        days: args.days,
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
 * Watches two things. The sync runs we just queued, by id — those are ours and we
 * know exactly which they are. And any rules pass that is queued or running in
 * those same workspaces, because a sync queues one behind itself and finishing
 * before it has run would report a job half done. A rules pass someone else
 * queued gets watched too; it is the same work, so waiting for it is honest.
 *
 * Read-only. Ctrl-C at any point leaves the queue exactly as it is and the worker
 * carries on — this is a viewer, not a lease.
 *
 * Returns the number of runs that ended `failed`, for the exit code.
 */
async function watch(queued: Queued[]): Promise<number> {
  const workspaces = [...new Set(queued.map((q) => q.workspaceId))];
  const ids = queued.map((q) => q.runId);
  const seen = new Map<string, string>();
  // Rules passes we have laid eyes on. They are found by *state* (queued/running),
  // since the one we are waiting for does not exist yet when this starts — but a
  // run dropping out of that state is precisely the moment worth reporting, so
  // once seen, a run is followed by id to whatever it ends as.
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

    // Done when every run in hand — the syncs we queued, and any rules pass they
    // set going — has reached a terminal state.
    if (runs.every((r) => TERMINAL.has(r.status))) return failures;

    // A queue that never moves usually means nobody is draining it. Say so once,
    // rather than spinning silently until the operator gives up on it.
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

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const args = parseArgs(process.argv.slice(2));

  ({ catalogDb, scopedDb } = await import("../lib/server/db"));
  ({ enqueueSync } = await import("../lib/server/queue"));

  const queued = await queueSyncs(args);

  if (queued.length === 0) {
    const where = args.workspace ? ` in "${args.workspace}"` : "";
    console.log(`no active bank links${where} — nothing to queue`);
    return;
  }

  if (args.drain) {
    // Imported here, not above: this is the branch that pulls in the whole ingest
    // pipeline and the rules engine's native addon. A plain `pnpm worker:sync` — the
    // cron path — loads neither.
    const { drainOnce } = await import("./drain");
    // Only the workspaces we just queued for: draining is a worker's job, but a
    // person doing it by hand for one workspace did not volunteer to run every
    // other workspace's jobs in this process.
    const processed = await drainOnce([...new Set(queued.map((q) => q.workspaceId))]);
    console.log(processed === 0 ? "\nqueue empty" : `\ndrained ${processed} run(s)`);
    return;
  }

  if (args.watch) {
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

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // This script owns its process, so it owns the disconnect. `catalogDb` is
    // undefined if we exited at `--help`, before the import.
    await catalogDb?.$disconnect();
  });
