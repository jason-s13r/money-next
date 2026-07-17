import { scopedDb } from "../db";
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

/** What a sync needs to know about the connection it is syncing. */
export type SyncLink = { id: string; workspaceId: string };

/**
 * What a sync did, for the `SyncRun` row the caller owns.
 *
 * Returned rather than written here because the run record brackets the sync —
 * the caller creates it before the first Akahu call and closes it in a `catch`
 * as well as on success — and a step that wrote to it from the middle would be
 * writing to a row it doesn't own the lifetime of.
 *
 * These are the same two numbers the console prints, deliberately: `/sync`
 * showing a different count from the log it came from would make both suspect.
 */
export type SyncCounts = {
  /** Accounts Akahu returned for this link and this pass upserted. */
  accountsSynced: number;
  /** Transactions upserted — the fetched window, not the rows that changed. */
  transactionsSynced: number;
};

/**
 * Run the same ingest pipeline used by `pnpm db:sync`, but usable from a server
 * action as well as from the cron script. `args.full` re-fetches the whole
 * history window; omitting it performs an incremental sync from the stored
 * high-water mark.
 *
 * Takes the link rather than a workspace id: a sync is something that happens to
 * a *connection*, and the workspace follows from it. That is also what turns the
 * caller into a plain loop once there is more than one link, rather than a
 * special case.
 *
 * The steps split cleanly in two. The financial steps run through a client scoped
 * to this link's workspace and stamp every row they write. The catalog steps —
 * NZFCC categories, ECB rates, Akahu's institution list — are shared reference
 * data, identical for everyone, and so run unscoped, once per pass rather than
 * once per workspace.
 */
export async function runSync(link: SyncLink, args: SyncArgs): Promise<SyncCounts> {
  const db = scopedDb(link.workspaceId);
  const capturedAt = startOfUtcDay(new Date());

  await syncCategories();
  const accounts = await fetchAccounts();
  await syncConnections(accounts);

  await syncAccounts(db, link, accounts, capturedAt);
  const syncedIds = await syncTransactions(db, link, args, accounts);
  await syncPendingTransactions(db, link, accounts);

  await syncFxRates();

  // Run the automations over just the rows this sync touched. Best-effort like
  // the category/FX steps: a broken rule graph shouldn't fail the financial sync,
  // which has already been committed above.
  try {
    const summary = await runRules(db, { transactionIds: syncedIds, trigger: "sync" });
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

  return { accountsSynced: accounts.length, transactionsSynced: syncedIds.length };
}
