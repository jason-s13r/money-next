"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { dismissalTokens } from "@/lib/server/pending-dismissal";

// Hiding pending holds, and un-hiding them. Both sit under `transactions/actions`
// with the bulk ones because the block they drive appears on two routes — the
// recent listing and an account's own page — and each takes the listing path to
// revalidate for the same reason those do.
//
// `enrichment.update` rather than a statement of its own: a dismissal is a
// standing instruction about how this household's rows are shown, which is the
// same power `/rules` is gated on. It is also the weakest of the writes that
// statement covers — nothing is deleted, no figure moves, and the hidden rows
// stay one click from view.

/**
 * Stop showing a pending hold, and any other hold like it.
 *
 * Takes the row and stores a *rule* derived from it — its bank, plus the
 * distinctive words of its description — because there is nothing else durable
 * to store. Pending rows are a snapshot replaced wholesale on every sync (see
 * `syncPendingTransactions`), so a dismissal keyed on this row's id would last
 * until the next one. Deriving a rule is what makes "hide this" hold for the
 * Wise cashback that comes back under a new id tomorrow, which is the case this
 * was built for.
 *
 * Silently a no-op when the id names nothing (the snapshot moved under the
 * click, which is normal) or when the description yields no token to match on —
 * a rule that matched on the bank alone would hide holds the person never saw.
 */
export async function dismissPending(pendingId: number, path: string) {
  await requireRole({ enrichment: ["update"] });

  // Scoped client, so an id from another workspace's snapshot finds nothing.
  const db = await getDb();
  const hold = await db.pendingTransaction.findFirst({
    where: { id: pendingId },
    select: { connectionId: true, description: true },
  });
  if (!hold) return;

  const tokens = dismissalTokens(hold.description);
  if (tokens.length === 0) return;

  // Two holds the same rule would cover are usually hidden by the first click, so
  // this mostly catches a double-submit — but a duplicate rule is invisible in the
  // listing (the first one already hid the row) and could only ever be removed by
  // undoing twice for no visible reason.
  const existing = await db.pendingDismissal.findFirst({
    where: { connectionId: hold.connectionId, tokens: { equals: tokens } },
    select: { id: true },
  });
  if (!existing) {
    await db.pendingDismissal.create({
      data: { workspaceId: db.$workspaceId, connectionId: hold.connectionId, tokens },
    });
  }

  await revalidateWorkspacePath(path);
}

/**
 * Drop a dismissal, bringing back every hold it was hiding — including ones the
 * person never dismissed by hand, which is why the listing names the rule rather
 * than offering an undo per row.
 *
 * `deleteMany` rather than `delete` for the reason `renameAccount` uses
 * `updateMany`: the id came from a page that may be a few seconds stale, and a
 * rule already gone is a finished job, not a server fault.
 */
export async function restorePending(dismissalId: string, path: string) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  await db.pendingDismissal.deleteMany({ where: { id: dismissalId } });

  await revalidateWorkspacePath(path);
}
