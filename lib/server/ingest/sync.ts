import { akahuFor, type TokenLink } from "../akahu";
import { scopedDb } from "../db";
import { enqueueRules } from "../queue";
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
 * What a sync needs to know about the connection it is syncing: which workspace
 * its rows belong to, and how to authenticate as it. The credentials are part of
 * the *link*, not of the process, which is what lets the caller stay a plain
 * loop over links now that two of them may belong to two different people's
 * Akahu accounts.
 */
export type SyncLink = TokenLink & { workspaceId: string };

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
  /** Accounts this pass upserted — what Akahu returned, less any superseded. */
  accountsSynced: number;
  /** Transactions upserted — the fetched window, not the rows that changed. */
  transactionsSynced: number;
};

/**
 * Run the same ingest pipeline used by `money sync`, but usable from a server
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
export async function runSync(
  link: SyncLink,
  args: SyncArgs,
  runId: string,
): Promise<SyncCounts> {
  const db = scopedDb(link.workspaceId);
  const capturedAt = startOfUtcDay(new Date());

  // Resolve this link's Akahu credentials once, here, and hand the resulting
  // client to every step that talks to Akahu. Each step reading the environment
  // for itself was harmless while there was one instance-wide token and is not
  // once there are several: a step that resolved its own could resolve a
  // *different* link's than the sync is for.
  const akahu = akahuFor(link);

  // Which accounts this workspace has retired into a successor. Read once and
  // handed to each step rather than re-queried by all three, and read *before*
  // the first write so that one answer governs the whole pass.
  //
  // Normally empty, and normally moot even when it isn't: Akahu stops returning
  // a migrated account, so the steps below would never see one anyway. It is
  // here for the case where that stops being true — a connection re-appearing
  // would otherwise quietly re-ingest the rows a merge had folded into the
  // survivor, and nothing about the resulting double count would look like a bug.
  const superseded = new Set(
    (
      await db.account.findMany({
        where: { supersededById: { not: null } },
        select: { id: true },
      })
    ).map((a) => a.id),
  );

  await syncCategories();
  const accounts = await fetchAccounts(akahu);
  await syncConnections(accounts);

  const accountsSynced = await syncAccounts(db, link, accounts, capturedAt, runId, superseded);
  const syncedIds = await syncTransactions(db, link, args, accounts, akahu, runId, superseded);
  await syncPendingTransactions(db, link, accounts, akahu, superseded);

  await syncFxRates();

  // Queue the automations rather than run them here. Queuing gets the
  // separation for free that an inline `runRules` used to need a try/catch for
  // — the rules pass is its own run, with its own retries, its own row in
  // /rules/runs and its own failure — and buys two things the inline version
  // couldn't have:
  //
  //   * Two links in one workspace produce **one** rules pass, not two. The
  //     enqueue coalesces per workspace, so the second sync's pass merges into
  //     the first's instead of walking the same rows again.
  //   * The pass covers the workspace rather than this sync's ids. That is more
  //     work, which is why it belongs on the worker, and it is what makes a rule
  //     authored between two syncs reach the transactions that already existed.
  //
  // Nothing is stomped by the wider scope: `applyOutput` never overwrites a
  // field a person owns, so re-evaluating an old transaction is idempotent
  // unless a rule genuinely changed.
  await enqueueRules(db, { trigger: "sync" });

  return { accountsSynced, transactionsSynced: syncedIds.length };
}
