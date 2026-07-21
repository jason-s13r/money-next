"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { requireRole } from "@/lib/server/auth/session";
import { type ScopedDb } from "@/lib/server/db";
import { getDb } from "@/lib/server/db/request";

/**
 * The bank link a queued sync will run against.
 *
 * Read through the scoped client, so it can only ever be *this* workspace's
 * link — the sync triggers can't be pointed at somebody else's connection by
 * anyone who reaches the endpoint. A workspace with no link is a normal state
 * (nobody has connected a bank yet), not an error condition, so it says so.
 *
 * Both actions below are public HTTP endpoints — that is what a server action
 * is — so each opens with a `requireRole` check rather than trusting that the
 * only caller is the button that renders next to it.
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
 * Enqueue a sync rather than run it (phase 7).
 *
 * The web role (`money_app`) used to run the whole ingest in-request — Akahu
 * fetch and all — which forced it to hold write access to the shared catalogs
 * (`Category`, `CategoryGroup`, `FxRate`, `Connection`) and the Akahu rate limit,
 * both shared across every workspace. Now the button writes a `SyncRun` in the
 * `queued` state — a *tenant* INSERT `money_app` already holds — and the
 * `money_sync` worker (scripts/worker.ts) picks it up, does the Akahu refresh and
 * the catalog mirroring, and finalises the row. So a compromise of the web role
 * can neither rewrite the catalogs nor spend the Akahu limit.
 *
 * Coalesced: a run already waiting to be claimed is reused rather than stacked, so
 * mashing the button doesn't pile up identical jobs. If that waiting run is a
 * failed one sitting out its retry backoff (`nextAttemptAt` in the future), a
 * person clicking "sync now" is an explicit override — clear the backoff so the
 * worker takes it on the next poll instead of making them wait it out.
 */
async function enqueueSync(db: ScopedDb) {
  const link = await syncLink(db);

  const waiting = await db.syncRun.findFirst({
    where: { status: "queued" },
    orderBy: { startedAt: "asc" },
  });
  if (waiting) {
    if (waiting.nextAttemptAt && waiting.nextAttemptAt > new Date()) {
      await db.syncRun.update({ where: { id: waiting.id }, data: { nextAttemptAt: null } });
    }
    return;
  }

  await db.syncRun.create({
    data: { workspaceId: db.$workspaceId, bankLinkId: link.id, status: "queued", full: false },
  });
}

/**
 * Queue an incremental sync: an Akahu refresh followed by a sync from the stored
 * high-water mark. The manual counterpart to the cron-driven `pnpm db:sync`.
 *
 * Returns as soon as the job is queued — the worker does the actual fetch, which
 * can take several seconds, so the button is no longer blocked on it. `/sync`
 * shows the run move queued → running → success, and refreshes itself while one is
 * in flight.
 */
export async function refreshAndSync() {
  // Until this line existed, this was an unauthenticated POST endpoint wired to
  // a button in the nav: anyone who could reach the port could queue syncs in a
  // loop (T3). The Akahu spend now belongs to the worker, but the enqueue is still
  // a state change that must carry `sync.run`.
  await requireRole({ sync: ["run"] });

  const db = await getDb();
  await enqueueSync(db);

  await revalidateWorkspacePath("/sync");
}
