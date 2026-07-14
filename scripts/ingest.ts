/**
 * Pulls accounts and transactions from Akahu into the local SQLite database.
 *
 *   pnpm db:sync              # incremental: since the newest stored transaction
 *   pnpm db:sync --full       # re-fetch the whole history window
 *   pnpm db:sync --days 90    # explicit lookback window
 *
 * Safe to re-run: every row is upserted on its Akahu id, so a sync that dies
 * halfway can simply be run again. Intended to be driven by cron.
 */
import { db } from "../lib/server/db";
import { runSync, type SyncArgs } from "../lib/server/sync";

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
  const run = await db.syncRun.create({ data: {} });

  try {
    await runSync(args);

    await db.syncRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        finishedAt: new Date(),
      },
    });

    console.log(`done (sync run #${run.id})`);
  } catch (error) {
    // Record the failure before rethrowing, otherwise a cron-driven sync that
    // keeps dying leaves no trace anywhere.
    await db.syncRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
