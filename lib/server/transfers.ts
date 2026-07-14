// The relational half of transfer handling: grouping two legs into one transfer,
// and finding the leg to group with. Kept free of `import "server-only"` (unlike
// lib/server/matching.ts) so the rules runner — which reaches here to auto-link a
// transfer, and itself runs inside the plain-Node ingest script as well as in the
// server — can import it. The interactive counterparts live in the transaction
// page's server action (which wraps `linkTransferLegs` with `revalidatePath`).

import { db } from "./db";
import type { Prisma } from "../generated/prisma/client";

/**
 * Put `targetId` in the same transfer group as `sourceId`, creating the group if
 * neither is in one yet, and merging the target's whole group into the source's
 * when both are already grouped — so a leg is never left in two transfers at once.
 * Writes only; callers in a request context revalidate afterwards.
 *
 * Returns `true` when a change was made, `false` when the two were already in the
 * same group (the no-op the auto-linker relies on to stay idempotent).
 */
export async function linkTransferLegs(sourceId: string, targetId: string): Promise<boolean> {
  if (sourceId === targetId) throw new Error("A transaction cannot be a transfer of itself.");

  const [source, target] = await Promise.all([
    db.transaction.findUnique({ where: { id: sourceId } }),
    db.transaction.findUnique({ where: { id: targetId } }),
  ]);
  if (!source) throw new Error(`Unknown transaction: ${sourceId}`);
  if (!target) throw new Error(`Unknown transaction: ${targetId}`);

  if (source.transferGroupId != null && source.transferGroupId === target.transferGroupId) {
    return false; // already in the same transfer
  }

  const groupId =
    source.transferGroupId ??
    target.transferGroupId ??
    (await db.transferGroup.create({ data: {} })).id;

  const writes: Prisma.PrismaPromise<unknown>[] = [];
  if (source.transferGroupId !== groupId) {
    writes.push(
      db.transaction.updateMany({ where: { id: sourceId }, data: { transferGroupId: groupId } }),
    );
  }
  if (target.transferGroupId !== groupId) {
    writes.push(
      db.transaction.updateMany({
        where:
          target.transferGroupId == null
            ? { id: targetId }
            : { transferGroupId: target.transferGroupId },
        data: { transferGroupId: groupId },
      }),
    );
    if (target.transferGroupId != null) {
      writes.push(db.transferGroup.delete({ where: { id: target.transferGroupId } }));
    }
  }
  await db.$transaction(writes);
  return true;
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
export async function findAutoTransferLeg(tx: {
  id: string;
  amount: number;
  date: Date;
  accountId: string;
  currency: string | null;
}): Promise<{ id: string } | null> {
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
