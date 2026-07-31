"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { mintId } from "@/lib/ids";
import { recordUserChanges } from "@/lib/server/changes";
import { applyEnrichment } from "@/lib/server/enrichment";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { withScopedTx } from "@/lib/server/db";
import { getCategories, getLabels, getMerchants } from "@/lib/server/queries/lookups";
import { clearCategoryGroup } from "@/lib/server/matching/transfers";

// The bulk counterparts of the single-row enrichment actions, driven by the
// transaction table's row-selection checkboxes. Each takes the selected ids and
// the current listing path, and revalidates that path so the list re-renders with
// the change. The scoped client filters every write, so ids from another
// workspace are simply not touched (and, for the change log, not logged either).
//
// Category and merchant are thin here on purpose: the write is `applyEnrichment`,
// the same one the detail page's setters go through, so "bulk" is a difference in
// how many ids arrive rather than a second implementation to keep in step.

/** Load the option sets the bulk bar's pickers need, on demand (first open). */
export async function loadPickerCatalog() {
  await requireRole({ enrichment: ["update"] });
  const [labels, merchants, categories] = await Promise.all([
    getLabels(),
    getMerchants(),
    getCategories(),
  ]);
  return {
    labels,
    merchants: merchants.map((m) => ({ id: m.id, name: m.name })),
    categories: categories.map((c) => ({ id: c.id, name: c.name, groupName: c.groupName })),
  };
}

/** Create a label (or reuse the workspace's existing one of that name) for the picker. */
export async function createLabelForBulk(name: string): Promise<{ id: string; name: string }> {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Label name is required");

  const existing = await db.label.findUnique({
    where: { workspaceId_name: { workspaceId: db.$workspaceId, name: trimmed } },
    select: { id: true, name: true },
  });
  if (existing) return existing;

  const label = await db.label.create({
    data: { id: mintId("label"), workspaceId: db.$workspaceId, name: trimmed },
    select: { id: true, name: true },
  });
  return label;
}

export async function bulkAddLabel(transactionIds: string[], labelId: string, path: string) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  if (transactionIds.length === 0) return;

  const label = await db.label.findUnique({ where: { id: labelId }, select: { id: true } });
  if (!label) throw new Error(`Unknown label: ${labelId}`);

  // Only tag transactions that are actually in this workspace, and skip any that
  // already carry the label, so `createMany` never trips the composite PK.
  const owned = await db.transaction.findMany({
    where: { id: { in: transactionIds } },
    select: { id: true },
  });
  const already = await db.transactionLabel.findMany({
    where: { labelId, transactionId: { in: owned.map((t) => t.id) } },
    select: { transactionId: true },
  });
  const has = new Set(already.map((r) => r.transactionId));
  const toAdd = owned.map((t) => t.id).filter((id) => !has.has(id));

  if (toAdd.length > 0) {
    await db.transactionLabel.createMany({
      data: toAdd.map((transactionId) => ({ workspaceId: db.$workspaceId, transactionId, labelId })),
    });
  }

  await revalidateWorkspacePath(path);
}

export async function bulkRemoveLabel(transactionIds: string[], labelId: string, path: string) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  if (transactionIds.length === 0) return;

  await db.transactionLabel.deleteMany({ where: { labelId, transactionId: { in: transactionIds } } });

  await revalidateWorkspacePath(path);
}

export async function bulkSetMerchant(
  transactionIds: string[],
  merchantId: string | null,
  path: string,
) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  await applyEnrichment(db, "merchant", transactionIds, merchantId);

  await revalidateWorkspacePath(path);
}

/**
 * Group every selected row into one transfer — the bulk face of the detail page's
 * `linkTransfer`, for when the reader can already *see* both legs in a listing and
 * ticking them is faster than opening one and hunting for the other.
 *
 * Done as a set operation rather than by replaying the one-pair linker down the
 * selection. The pairwise version read as the obvious generalisation — anchor,
 * then link each of the rest to it — but it costs a round trip per leg *inside* an
 * interactive transaction, and Prisma gives one of those five seconds. A forty-row
 * link, which is exactly the size that makes the bulk action worth having, is
 * where that runs out. Merging groups is set-shaped anyway: there is one surviving
 * group and everything else is folded into it, which is four statements whether
 * the reader ticked two rows or two hundred.
 */
export async function bulkLinkTransfer(transactionIds: string[], path: string) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  if (transactionIds.length < 2) return;

  // The scoped read both filters out ids from another workspace and dedupes, so a
  // row can never be linked to itself. Oldest first, so which row ends up the
  // anchor doesn't depend on the order the reader ticked.
  const owned = await db.transaction.findMany({
    where: { id: { in: transactionIds } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    select: { id: true, description: true, transferGroupId: true },
  });
  if (owned.length < 2) return;

  const [anchor, ...rest] = owned;

  // The group everything ends up in: the anchor's if it has one, otherwise the
  // first group any selected row belongs to, otherwise one made below. Reusing an
  // existing group rather than always minting one is what carries along the legs
  // that are *not* selected — a row already in a transfer brings its whole group.
  const groups = [...new Set(owned.map((tx) => tx.transferGroupId).filter((id) => id !== null))];
  const surviving = anchor.transferGroupId ?? groups[0] ?? null;

  // Which legs the reader actually joined to the anchor — the pairs worth logging.
  // Measured against the anchor's *original* group, not the surviving one: when the
  // anchor had none and a leg brought one, it is the anchor that moved, and the two
  // are newly in a transfer together either way. Comparing against `surviving`
  // would call that leg unchanged and lose the pair.
  const linked = rest.filter(
    (leg) => anchor.transferGroupId === null || leg.transferGroupId !== anchor.transferGroupId,
  );
  if (linked.length === 0) return; // everything ticked is already one transfer

  await withScopedTx(db, async (tx) => {
    const groupId =
      surviving ?? (await tx.transferGroup.create({ data: { workspaceId: db.$workspaceId } })).id;

    // Fold the other groups in whole, then delete the husks. `updateMany` on the
    // group id (not the selected ids) is what brings unselected legs with them.
    const absorbed = groups.filter((id) => id !== groupId);
    if (absorbed.length > 0) {
      await tx.transaction.updateMany({
        where: { transferGroupId: { in: absorbed } },
        data: { transferGroupId: groupId },
      });
      await tx.transferGroup.deleteMany({ where: { id: { in: absorbed } } });
    }

    // Whatever is left: the selected rows that belonged to no transfer at all.
    const loose = owned.filter((tx) => tx.transferGroupId === null).map((tx) => tx.id);
    if (loose.length > 0) {
      await tx.transaction.updateMany({
        where: { id: { in: loose } },
        data: { transferGroupId: groupId },
      });
    }

    await clearCategoryGroup(tx, groupId);

    // Both sides of every pair that actually moved, as the single-row action
    // does: a transfer is a fact about each of its legs, so opening any one of
    // them should explain how it came to be part of this transfer. In the
    // transaction, so the log cannot outlive a grouping that rolled back.
    await recordUserChanges(
      tx,
      linked.flatMap((leg) => [
        { transactionId: anchor.id, field: "transfer" as const, toLabel: leg.description },
        { transactionId: leg.id, field: "transfer" as const, toLabel: anchor.description },
      ]),
    );
  });

  await revalidateWorkspacePath(path);
  await Promise.all(owned.map((tx) => revalidateWorkspacePath(`/transactions/${tx.id}`)));
}

export async function bulkSetCategory(
  transactionIds: string[],
  categoryId: string | null,
  path: string,
) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  await applyEnrichment(db, "category", transactionIds, categoryId);

  await revalidateWorkspacePath(path);
}
