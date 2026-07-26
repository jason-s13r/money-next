"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { mintId } from "@/lib/ids";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { getLabels } from "@/lib/server/queries/lookups";

/**
 * The workspace's labels, for the inline tag picker in a transaction row / on the
 * detail page. A thin server-action wrapper over the cached `getLabels` read so a
 * client component can populate the picker without the whole listing shipping the
 * catalog to every row.
 */
export async function listLabels() {
  await requireRole({ enrichment: ["update"] });
  return getLabels();
}

// Tagging a single transaction from its own page. Labels are the one enrichment
// that is purely the user's — nothing about them is mirrored from Akahu — so
// unlike category/merchant these writes keep no `*Source`, raise no
// `TransactionConflict`, and are never reconciled against a sync. They are plain
// scoped writes; the scoped client stamps and RLS-guards the workspace.

/**
 * Confirm a label and a transaction both belong to the current workspace before
 * joining them. The scoped client filters both reads, so a `null` here means the
 * id names another workspace's row (or nothing) — and joining them anyway would
 * plant a join row in this workspace pointing at a foreign label, which RLS's
 * `workspaceId` check alone would not catch.
 */
async function assertOwned(
  db: Awaited<ReturnType<typeof getDb>>,
  transactionId: string,
  labelId: string,
) {
  const [tx, label] = await Promise.all([
    db.transaction.findUnique({ where: { id: transactionId }, select: { id: true } }),
    db.label.findUnique({ where: { id: labelId }, select: { id: true } }),
  ]);
  if (!tx) throw new Error(`Unknown transaction: ${transactionId}`);
  if (!label) throw new Error(`Unknown label: ${labelId}`);
}

export async function addTransactionLabel(transactionId: string, labelId: string) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  await assertOwned(db, transactionId, labelId);

  // Idempotent: re-adding a tag a transaction already has is a no-op, not an error
  // — the inline picker and the bulk bar both lean on that.
  await db.transactionLabel.upsert({
    where: { transactionId_labelId: { transactionId, labelId } },
    create: { workspaceId: db.$workspaceId, transactionId, labelId },
    update: {},
  });

  await revalidateWorkspacePath(`/transactions/${transactionId}`);
}

export async function removeTransactionLabel(transactionId: string, labelId: string) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  await db.transactionLabel.deleteMany({ where: { transactionId, labelId } });

  await revalidateWorkspacePath(`/transactions/${transactionId}`);
}

/**
 * Create a label from the transaction page (or reuse the workspace's existing tag
 * of that name) and attach it. The id is minted under this instance's namespace
 * (`app_label_...`, see `mintId`) so it can never be mistaken for an Akahu id, and
 * the row is private by virtue of its `workspaceId`, not its id.
 */
export async function createLabelAndAddToTransaction(transactionId: string, name: string) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Label name is required");

  const tx = await db.transaction.findUnique({ where: { id: transactionId }, select: { id: true } });
  if (!tx) throw new Error(`Unknown transaction: ${transactionId}`);

  // Names are unique per workspace, so "create" reuses the existing tag rather
  // than colliding on it — the same forgiving behaviour the merchant picker has.
  const label =
    (await db.label.findUnique({ where: { workspaceId_name: { workspaceId: db.$workspaceId, name: trimmed } } })) ??
    (await db.label.create({ data: { id: mintId("label"), workspaceId: db.$workspaceId, name: trimmed } }));

  await db.transactionLabel.upsert({
    where: { transactionId_labelId: { transactionId, labelId: label.id } },
    create: { workspaceId: db.$workspaceId, transactionId, labelId: label.id },
    update: {},
  });

  await revalidateWorkspacePath(`/transactions/${transactionId}`);
}
