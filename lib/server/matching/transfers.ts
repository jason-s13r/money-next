// The relational half of transfer handling: grouping two legs into one transfer,
// and finding the leg to group with. Kept free of `import "server-only"` (unlike
// lib/server/matching.ts) so the rules runner — which reaches here to auto-link a
// transfer, and itself runs inside the plain-Node ingest script as well as in the
// server — can import it. The interactive counterparts live in the transaction
// page's server action (which wraps `linkTransferLegs` with `revalidatePath`).

import { withScopedTx, type ScopedDb, type ScopedTx } from "../db";

/**
 * Put `targetId` in the same transfer group as `sourceId`, creating the group if
 * neither is in one yet, and merging the target's whole group into the source's
 * when both are already grouped — so a leg is never left in two transfers at once.
 * Writes only; callers in a request context revalidate afterwards.
 *
 * Returns `true` when a change was made, `false` when the two were already in the
 * same group (the no-op the auto-linker relies on to stay idempotent).
 *
 * `log` runs inside the same transaction as the link, and only when there is a
 * link to describe. It exists because the two callers attribute their writes
 * differently — a person clicked, or a rule fired — and `source` is the whole
 * point of the change log, so this function cannot decide it. What it *can*
 * decide is that whatever the caller writes about the link commits with the link:
 * a log entry for a grouping that rolled back is worse than no entry at all.
 */
export async function linkTransferLegs(
  db: ScopedDb,
  sourceId: string,
  targetId: string,
  log?: (tx: ScopedTx) => Promise<void>,
): Promise<boolean> {
  if (sourceId === targetId) throw new Error("A transaction cannot be a transfer of itself.");

  const [source, target] = await Promise.all([
    db.transaction.findUnique({ where: { id: sourceId } }),
    db.transaction.findUnique({ where: { id: targetId } }),
  ]);
  if (!source) throw new Error(`Unknown transaction: ${sourceId}`);
  if (!target) throw new Error(`Unknown transaction: ${targetId}`);

  // Belt and braces over the scoped client, which already filtered both reads.
  // This is the sharpest IDOR in the app and the damage is *corruption*, not just
  // a leak: pull another workspace's row into a transfer group and its legs drop
  // out of that workspace's income/spend metrics, silently falsifying numbers
  // nobody is looking at. The auto-linker also calls this outside any request, so
  // the assertion is worth its two lines.
  if (source.workspaceId !== db.$workspaceId || target.workspaceId !== db.$workspaceId) {
    throw new Error("Refusing to link transfer legs across workspaces.");
  }

  if (source.transferGroupId != null && source.transferGroupId === target.transferGroupId) {
    return false; // already in the same transfer
  }

  // One atomic transaction, with the RLS session variable set once for all of it
  // (see withScopedTx). The group is created inside it too — a new group and the
  // legs that justify it commit together or not at all, so a failed update can't
  // strand an empty group.
  await withScopedTx(db, async (tx) => {
    const groupId =
      source.transferGroupId ??
      target.transferGroupId ??
      (await tx.transferGroup.create({ data: { workspaceId: db.$workspaceId } })).id;

    if (source.transferGroupId !== groupId) {
      await tx.transaction.updateMany({ where: { id: sourceId }, data: { transferGroupId: groupId } });
    }
    if (target.transferGroupId !== groupId) {
      await tx.transaction.updateMany({
        where:
          target.transferGroupId == null
            ? { id: targetId }
            : { transferGroupId: target.transferGroupId },
        data: { transferGroupId: groupId },
      });
      if (target.transferGroupId != null) {
        await tx.transferGroup.delete({ where: { id: target.transferGroupId } });
      }
    }

    await clearCategoryGroup(tx, groupId);
    await log?.(tx);
  });
  return true;
}

/**
 * Strip the category group from every leg of a transfer.
 *
 * A transfer's legs are money moving between the user's own accounts, not income
 * or spending, so they carry no category group. Cleared across the whole group —
 * including any leg linked before this existed — so a transfer never lands in an
 * income breakdown. The ingest side suppresses the same "Other Income" fallback
 * for TRANSFER-type rows, so a later sync won't put it back.
 *
 * Shared by the one-pair linker above and the bulk linker in the transactions
 * action, which are otherwise different shapes: this is the rule about what a
 * transfer *is*, and it should not be stated twice.
 */
export async function clearCategoryGroup(tx: ScopedTx, groupId: string): Promise<void> {
  await tx.transaction.updateMany({
    where: { transferGroupId: groupId },
    data: { categoryGroupId: null },
  });
}

// The auto-linker is deliberately narrower than the interactive candidate finder
// in matching.ts (`getTransferCandidates`): it only links when it is *sure*, so it
// handles the common same-currency, amount-offsetting pair and leaves anything
// ambiguous — multiple candidates, or a cross-currency conversion — to the manual
// flow. The window and tolerance mirror matching.ts (re-declared here to keep this
// module free of the server-only import).

const TRANSFER_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How far a candidate's amount may differ from exactly offsetting the source and
 *  still count as its leg: the greater of $2 or 1%, to absorb a skimmed fee. */
function transferTolerance(amount: number): number {
  return Math.max(2, Math.abs(amount) * 0.01);
}

/**
 * The single unambiguous opposite leg of `tx`, or null. A leg qualifies when it is
 * ungrouped, in a *different* account of the *same* currency, dated within the
 * transfer window, and its amount offsets `tx`'s within `transferTolerance`. If
 * zero or more than one row qualifies, returns null — the auto-linker only acts on
 * a certain, one-to-one match and defers the rest to manual linking.
 */
export async function findAutoTransferLeg(
  db: ScopedDb,
  tx: {
    id: string;
    amount: number;
    date: Date;
    accountId: string;
    currency: string | null;
  },
): Promise<{ id: string } | null> {
  const opposite = -tx.amount;
  const tol = transferTolerance(tx.amount);
  const windowMs = TRANSFER_WINDOW_DAYS * DAY_MS;

  const matches = await db.transaction.findMany({
    where: {
      id: { not: tx.id },
      transferGroupId: null,
      accountId: { not: tx.accountId },
      amount: { gte: opposite - tol, lte: opposite + tol },
      account: { is: { currency: tx.currency } },
      date: {
        gte: new Date(tx.date.getTime() - windowMs),
        lte: new Date(tx.date.getTime() + windowMs),
      },
    },
    select: { id: true },
    take: 2,
  });

  return matches.length === 1 ? matches[0] : null;
}
