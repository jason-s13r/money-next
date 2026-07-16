"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/server/db";
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
  await linkTransferLegs(sourceId, targetId);

  revalidatePath(`/transactions/${sourceId}`);
  revalidatePath(`/transactions/${targetId}`);
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
  const tx = await db.transaction.findUnique({ where: { id: transactionId } });
  if (!tx || tx.transferGroupId == null) return;

  const groupId = tx.transferGroupId;
  const others = await db.transaction.findMany({
    where: { transferGroupId: groupId, id: { not: transactionId } },
    select: { id: true },
  });

  const writes: Prisma.PrismaPromise<unknown>[] = [
    db.transaction.update({ where: { id: transactionId }, data: { transferGroupId: null } }),
  ];
  // A one-leg "transfer" is meaningless: release the straggler and drop the group.
  if (others.length <= 1) {
    writes.push(
      db.transaction.updateMany({ where: { transferGroupId: groupId }, data: { transferGroupId: null } }),
      db.transferGroup.delete({ where: { id: groupId } }),
    );
  }
  await db.$transaction(writes);

  revalidatePath(`/transactions/${transactionId}`);
  for (const o of others) revalidatePath(`/transactions/${o.id}`);
}
