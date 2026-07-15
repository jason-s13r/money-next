import { runRules } from "../rules/engine";
import { syncCategories } from "./categories";
import { syncFxRates } from "./fx";
import { fetchAccounts, syncAccounts, syncConnections } from "./accounts";
import { syncTransactions } from "./transactions";
import { syncPendingTransactions } from "./pending";
import type { SyncArgs } from "./shared";

export type { SyncArgs } from "./shared";

/** Snapshots are keyed per-day, so re-running on the same day updates in place. */
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Run the same ingest pipeline used by `pnpm db:sync`, but usable from a server
 * action as well as from the cron script. `args.full` re-fetches the whole
 * history window; omitting it performs an incremental sync from the stored
 * high-water mark.
 */
export async function runSync(args: SyncArgs): Promise<void> {
  const capturedAt = startOfUtcDay(new Date());
  await syncCategories();
  const accounts = await fetchAccounts();
  await syncConnections(accounts);
  await syncAccounts(accounts, capturedAt);
  const syncedIds = await syncTransactions(args, accounts);
  await syncPendingTransactions(accounts);
  await syncFxRates();

  // Run the automations over just the rows this sync touched. Best-effort like
  // the category/FX steps: a broken rule graph shouldn't fail the financial sync,
  // which has already been committed above.
  try {
    const summary = await runRules({ transactionIds: syncedIds, trigger: "sync" });
    if (summary.ran) {
      console.log(
        `rules:        ${summary.evaluated} evaluated — ` +
          `${summary.categorised} categorised, ${summary.merchantsSet} merchants, ` +
          `${summary.transfersLinked} transfers linked` +
          (summary.errors ? `, ${summary.errors} errored` : ""),
      );
    } else {
      console.log("rules:        skipped — no active rule document");
    }
  } catch (error) {
    console.warn(`rules:        skipped — ${error instanceof Error ? error.message : String(error)}`);
  }
}
