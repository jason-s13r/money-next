"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { requireRole } from "@/lib/server/auth/session";
import { type ScopedDb } from "@/lib/server/db";
import { getDb } from "@/lib/server/db/request";
import { enqueueSync } from "@/lib/server/queue";

/**
 * Thrown when a sync is asked for in a workspace that has no bank connected.
 *
 * Not a fault: a workspace starts with no link and stays that way until a bank
 * is connected. So the person clicking Sync has done nothing wrong, and
 * "something went wrong, trying again is safe" is both untrue and unhelpful —
 * no retry succeeds until a link exists.
 *
 * Carries its own `digest`: in production Next strips a server error's
 * `message` before it reaches the browser, and a digest the error brought
 * with it is the one field that survives. The error boundary matches on this
 * string. Safe to expose — it says the workspace has no bank, which is a thing
 * about the viewer's own workspace that the page already implies everywhere
 * else.
 */
class NoBankLinkError extends Error {
  readonly digest = "NO_BANK_LINK";

  constructor() {
    super("No bank is connected to this workspace.");
    this.name = "NoBankLinkError";
  }
}

/**
 * The bank link a queued sync will run against.
 *
 * Read through the scoped client, so it can only ever be *this* workspace's
 * link — the sync triggers can't be pointed at somebody else's connection by
 * anyone who reaches the endpoint. A workspace with no link is a normal state
 * (nobody has connected a bank yet), not an error condition, so it says so —
 * `NoBankLinkError` above is how that reaches the person rather than the log.
 *
 * Both actions below are public HTTP endpoints — that is what a server action
 * is — so each opens with a `requireRole` check rather than trusting that the
 * only caller is the button that renders next to it.
 */
async function syncLink(db: ScopedDb) {
  const link = await db.bankLink.findFirst({
    where: { status: "ACTIVE" },
    // Only the id, and explicitly: a bare `findFirst` selects every column,
    // which includes the encrypted Akahu token. The web role has no key to
    // decrypt it with, but there is no reason for the ciphertext to be in this
    // process's memory at all when all the caller wants is which link to queue
    // a sync for.
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!link) throw new NoBankLinkError();
  return link;
}

/**
 * Enqueue a sync rather than run it. The button writes a `SyncRun` in the
 * `queued` state — a *tenant* INSERT the web role already holds — and the
 * worker picks it up, does the Akahu refresh and the catalog mirroring, and
 * finalises the row. So a compromise of the web role can neither rewrite the
 * shared catalogs nor spend the Akahu rate limit.
 *
 * The enqueue itself is shared with the scheduled sync — the coalescing rules
 * are the interesting part and there is no version of them that should differ
 * between a button and a cron. `clearBackoff` is where the two do differ: a
 * person clicking "sync now" at a run sitting out its retry backoff is an
 * explicit override, so the wait is dropped; a timer arriving mid-backoff
 * must not reset it.
 */
async function enqueueSyncNow(db: ScopedDb) {
  const link = await syncLink(db);
  await enqueueSync(db, { bankLinkId: link.id, clearBackoff: true });
}

/**
 * Queue an incremental sync: an Akahu refresh followed by a sync from the stored
 * high-water mark. The manual counterpart to the cron-driven `money sync`.
 *
 * Returns as soon as the job is queued — the worker does the actual fetch, which
 * can take several seconds, so the button is no longer blocked on it. `/sync`
 * shows the run move queued → running → success, and refreshes itself while one is
 * in flight.
 */
export async function refreshAndSync() {
  // Without this line the action is an unauthenticated POST wired to a button in
  // the nav: anyone who could reach the port could queue syncs in a loop. The
  // Akahu spend belongs to the worker now, but the enqueue is still a state
  // change that must carry `sync.run`.
  await requireRole({ sync: ["run"] });

  const db = await getDb();
  await enqueueSyncNow(db);

  await revalidateWorkspacePath("/sync");
}
