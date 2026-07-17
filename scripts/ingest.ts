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
import { catalogDb } from "../lib/server/db";
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

  // Deciding *which* workspaces to sync is the one job here that legitimately
  // spans them, so it is the one query with no workspace to be scoped to.
  const links = await catalogDb.bankLink.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, workspaceId: true },
    orderBy: { createdAt: "asc" },
  });

  if (links.length === 0) {
    console.log("no active bank links — nothing to sync");
    return;
  }

  let failures = 0;

  for (const link of links) {
    if (links.length > 1) console.log(`\n=== ${link.name} (${link.workspaceId}) ===`);

    const run = await catalogDb.syncRun.create({
      data: { workspaceId: link.workspaceId, bankLinkId: link.id },
    });

    try {
      const counts = await runSync(link, args);
      await catalogDb.syncRun.update({
        where: { id: run.id },
        data: { status: "success", finishedAt: new Date(), ...counts },
      });
      console.log(`done (sync run #${run.id})`);
    } catch (error) {
      // Record the failure before moving on, otherwise a cron-driven sync that
      // keeps dying leaves no trace anywhere. One link failing must not stop the
      // rest: they are different people's money.
      failures++;
      await catalogDb.syncRun.update({
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

  await catalogDb.$disconnect();
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
