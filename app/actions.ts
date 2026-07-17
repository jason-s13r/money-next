"use server";

import { revalidatePath } from "next/cache";
import { akahuClient, akahuUserToken } from "@/lib/server/akahu";
import { runSync, type SyncCounts, type SyncLink } from "@/lib/server/ingest/sync";
import { getDb, type ScopedDb } from "@/lib/server/db";

/**
 * The bank link these actions sync.
 *
 * Read through the scoped client, so it can only ever be *this* workspace's
 * link — the sync triggers can't be pointed at somebody else's connection by
 * anyone who reaches the endpoint. A workspace with no link is a normal state
 * (nobody has connected a bank yet), not an error condition, so it says so.
 *
 * Both actions below are still public HTTP endpoints today: there is no auth
 * until phase 3, when they gain `requireSession()` and an owner/editor check.
 */
async function syncLink(db: ScopedDb) {
  const link = await db.bankLink.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
  if (!link) throw new Error("No bank is connected to this workspace.");
  return link;
}

/**
 * Bracket a sync with the `SyncRun` row that records it: open before the first
 * Akahu call, close on the way out whether it succeeded or threw.
 *
 * Shared by both actions because both need identical bookkeeping, and one of
 * them was previously missing it entirely — `refreshAndSync` ran the whole
 * ingest and recorded nothing, so the staleness marker in the nav never moved
 * when you pressed the sync button sitting next to it, and the run never
 * reached `/sync`. A failure is recorded and re-thrown: the caller still needs
 * to fail, but the reason belongs in the log rather than only in a stack trace
 * nobody kept.
 */
async function recordRun(db: ScopedDb, run: (link: SyncLink) => Promise<SyncCounts>) {
  const link = await syncLink(db);
  const row = await db.syncRun.create({
    data: { workspaceId: db.$workspaceId, bankLinkId: link.id },
  });

  try {
    const counts = await run(link);
    await db.syncRun.update({
      where: { id: row.id },
      data: { status: "success", finishedAt: new Date(), ...counts },
    });
  } catch (error) {
    await db.syncRun.update({
      where: { id: row.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

/**
 * Ask Akahu to refresh all connected accounts, then run a local incremental sync.
 *
 * This is the manual counterpart to the cron-driven `pnpm db:sync`. It is safe
 * to call repeatedly: Akahu's refresh is idempotent for a given connection, and
 * the ingest upserts every row on its Akahu id.
 */
export async function refreshAndSync() {
  const db = await getDb();

  await recordRun(db, async (link) => {
    const akahu = akahuClient();
    await akahu.accounts.refreshAll(akahuUserToken());
    return runSync(link, { full: false });
  });

  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath("/sync");
}

/**
 * Run a full historical sync and record it as a `SyncRun`, just like the cron
 * script does. This can take a while, so it is offered as an explicit action
 * rather than running on every page load.
 */
export async function fullSync() {
  const db = await getDb();

  await recordRun(db, async (link) => {
    const akahu = akahuClient();
    await akahu.accounts.refreshAll(akahuUserToken());
    return runSync(link, { full: true });
  });
  // Deliberately no `db.$disconnect()` here. This runs inside the server, where
  // the client is shared by every request — disconnecting it would tear down the
  // connection pool under whatever else is mid-flight. Only a script that owns
  // its process should disconnect (see scripts/ingest.ts).

  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath("/sync");
}
