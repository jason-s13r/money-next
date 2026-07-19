/**
 * Pulls accounts and transactions from Akahu into the database.
 *
 *   pnpm db:sync              # incremental: since the newest stored transaction
 *   pnpm db:sync --full       # re-fetch the whole history window
 *   pnpm db:sync --days 90    # explicit lookback window
 *
 * Safe to re-run: every row is upserted on its Akahu id, so a sync that dies
 * halfway can simply be run again. Intended to be driven by cron.
 *
 * Syncs every ACTIVE bank link, one workspace at a time — a loop of one today,
 * and the reason the multi-tenant version needs no new entry point. Each link
 * gets its own SyncRun, so a failure is attributable to a connection rather than
 * to "the sync".
 */
import { catalogDb, scopedDb } from "../lib/server/db";
import { runSync, type SyncArgs } from "../lib/server/ingest/sync";

function parseArgs(argv: string[]): SyncArgs {
  const full = argv.includes("--full");
  const daysFlag = argv.indexOf("--days");
  const days = daysFlag !== -1 ? Number(argv[daysFlag + 1]) : undefined;
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    throw new Error(`--days expects a positive number, got: ${argv[daysFlag + 1]}`);
  }
  return { full, days };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // *Which* workspaces exist is the one question here that legitimately spans
  // tenants, and it is control-plane data — Workspace is unscoped, so this read
  // is the one with no workspace to scope to. Everything below runs through a
  // client scoped to a single workspace, which under RLS (phase 6) is also what
  // lets the sync role touch these rows at all: an unscoped read of BankLink or
  // write of SyncRun now matches or permits nothing. The prior version read
  // BankLink and wrote SyncRun through the unscoped catalog client; RLS forces
  // the per-workspace loop the design always intended.
  const workspaces = await catalogDb.workspace.findMany({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  let failures = 0;
  let synced = 0;

  for (const { id: workspaceId } of workspaces) {
    const db = scopedDb(workspaceId);
    const links = await db.bankLink.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, workspaceId: true },
      orderBy: { createdAt: "asc" },
    });

    for (const link of links) {
      synced++;
      console.log(`\n=== ${link.name} (${link.workspaceId}) ===`);

      const run = await db.syncRun.create({
        data: { workspaceId: link.workspaceId, bankLinkId: link.id },
      });

      try {
        const counts = await runSync(link, args);
        await db.syncRun.update({
          where: { id: run.id },
          data: { status: "success", finishedAt: new Date(), ...counts },
        });
        console.log(`done (sync run #${run.id})`);
      } catch (error) {
        // Record the failure before moving on, otherwise a cron-driven sync that
        // keeps dying leaves no trace anywhere. One link failing must not stop the
        // rest: they are different people's money.
        failures++;
        await db.syncRun.update({
          where: { id: run.id },
          data: {
            status: "failed",
            finishedAt: new Date(),
            error: error instanceof Error ? error.message : String(error),
          },
        });
        console.error(`sync run #${run.id} failed:`, error);
      }
    }
  }

  if (synced === 0) console.log("no active bank links — nothing to sync");

  await catalogDb.$disconnect();
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
