"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { recordUserChanges } from "@/lib/server/changes";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { withScopedTx } from "@/lib/server/db";
import { money } from "@/lib/server/money";
import { linkTransferLegs } from "@/lib/server/matching/transfers";

// Grouping transactions as the legs of one internal transfer, and ungrouping
// them. A `TransferGroup` holds two *or more* legs — an out/in pair, but also a
// currency conversion or a separate fee row — and every leg carries the group's id
// in `transferGroupId`, so "is this a transfer" stays a single `transferGroupId:
// null` test that the metrics and listings lean on. Akahu never says which rows
// belong together, so these groups are always user-made.

/**
 * Put `targetId` in the same transfer group as `sourceId`, creating the group if
 * neither is in one yet. If they are already in different groups the target's
 * whole group is merged into the source's, then the emptied group is removed —
 * so linking never leaves a transaction in two transfers at once.
 */
export async function linkTransfer(sourceId: string, targetId: string) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();

  // What the log entries say is decided here rather than inside
  // `linkTransferLegs`, which is shared with the rules auto-linker and so cannot
  // know whether a person or a rule is asking — and `source` is the whole point
  // of the log. Each caller attributes its own; the shared function stays
  // mechanical. Handed *down* as a callback so the entries commit in the same
  // transaction as the grouping they describe.
  const legs = await db.transaction.findMany({
    where: { id: { in: [sourceId, targetId] } },
    select: { id: true, description: true },
  });
  const describe = (id: string) => legs.find((l) => l.id === id)?.description ?? null;

  // Both legs, because a transfer is a fact about both of them: opening either
  // transaction should show how it came to be part of this transfer.
  const linked = await linkTransferLegs(db, sourceId, targetId, (tx) =>
    recordUserChanges(tx, [
      { transactionId: sourceId, field: "transfer", toLabel: describe(targetId) },
      { transactionId: targetId, field: "transfer", toLabel: describe(sourceId) },
    ]),
  );
  if (!linked) return;

  await revalidateWorkspacePath(`/transactions/${sourceId}`);
  await revalidateWorkspacePath(`/transactions/${targetId}`);
}

// Text fields a transfer counterpart might be recognised by when the automatic
// candidates (see `getTransferCandidates`) can't find it — a cross-institution,
// cross-currency transfer whose legs share neither amount, timestamp, nor wording.
// The merchant name is matched separately, through its relation.
const TRANSFER_SEARCH_FIELDS = [
  "description",
  "reference",
  "particulars",
  "code",
  "otherAccount",
] as const;

/**
 * Free-text search over *ungrouped* transactions, to hand-pick a transfer leg the
 * heuristics miss. Excludes the source row and anything already in a transfer.
 * `mode: "insensitive"` is required: Postgres' LIKE is case-sensitive, and a
 * reader searching for a counterparty does not type it in the bank's caps.
 */
export async function searchTransferCandidates(sourceId: string, query: string) {
  const db = await getDb();
  const q = query.trim();
  if (q.length < 2) return [];
  const rows = await db.transaction.findMany({
    where: {
      id: { not: sourceId },
      transferGroupId: null,
      OR: [
        ...TRANSFER_SEARCH_FIELDS.map((field) => ({
          [field]: { contains: q, mode: "insensitive" },
        })),
        { merchant: { is: { name: { contains: q, mode: "insensitive" } } } },
      ],
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: 15,
    select: {
      id: true,
      date: true,
      amount: true,
      description: true,
      merchant: { select: { name: true } },
      account: { select: { name: true, currency: true } },
    },
  });
  // This is a server action returning to a client component, so `amount` must be
  // a plain number: a decimal.js instance cannot cross that boundary.
  return rows.map((r) => ({ ...r, amount: money(r.amount) }));
}

export type TransferSearchResult = Awaited<
  ReturnType<typeof searchTransferCandidates>
>[number];

/**
 * Take `transactionId` out of its transfer group. If that leaves the group with a
 * single leg it is no longer a transfer, so the last member is released too and
 * the empty group deleted.
 */
export async function unlinkTransfer(transactionId: string) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  const tx = await db.transaction.findUnique({ where: { id: transactionId } });
  if (!tx || tx.transferGroupId == null) return;

  const groupId = tx.transferGroupId;
  const others = await db.transaction.findMany({
    where: { transferGroupId: groupId, id: { not: transactionId } },
    select: { id: true, description: true },
  });

  // A one-leg "transfer" is meaningless: release the straggler and drop the group.
  const releasesOthers = others.length <= 1;
  // One atomic transaction with the RLS variable set once (see withScopedTx). The
  // log goes in it too: a row saying a leg left a transfer, written after the
  // release that failed to commit, is a lie the log has no way to retract.
  await withScopedTx(db, async (scoped) => {
    await scoped.transaction.update({
      where: { id: transactionId },
      data: { transferGroupId: null },
    });
    if (releasesOthers) {
      await scoped.transaction.updateMany({
        where: { transferGroupId: groupId },
        data: { transferGroupId: null },
      });
      await scoped.transferGroup.delete({ where: { id: groupId } });
    }

    // The unlinked leg, plus any straggler this released — a leg that falls out
    // of a transfer because the group collapsed did have its field changed, even
    // though nobody clicked on it, and the log's job is to explain exactly that
    // kind of change when someone later asks why.
    await recordUserChanges(scoped, [
      {
        transactionId,
        field: "transfer",
        fromLabel: others.map((o) => o.description).join(", ") || null,
      },
      ...(releasesOthers
        ? others.map((o) => ({
            transactionId: o.id,
            field: "transfer" as const,
            fromLabel: tx.description,
          }))
        : []),
    ]);
  });

  await revalidateWorkspacePath(`/transactions/${transactionId}`);
  for (const o of others) await revalidateWorkspacePath(`/transactions/${o.id}`);
}
