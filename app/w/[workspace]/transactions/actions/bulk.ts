"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { mintId } from "@/lib/ids";
import { recordUserChanges } from "@/lib/server/changes";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { getCategories, getLabels, getMerchants } from "@/lib/server/queries/lookups";

// The bulk counterparts of the single-row enrichment actions, driven by the
// transaction table's row-selection checkboxes. Each takes the selected ids and
// the current listing path, and revalidates that path so the list re-renders with
// the change. The scoped client filters every write, so ids from another
// workspace are simply not touched (and, for the change log, not logged either).

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
  if (transactionIds.length === 0) return;

  const merchant = merchantId
    ? await db.merchant.findUnique({ where: { id: merchantId }, select: { id: true, name: true } })
    : null;
  if (merchantId && !merchant) throw new Error(`Unknown merchant: ${merchantId}`);

  // One read for the whole batch — the same shape the per-page `applyMerchantToTransactions`
  // uses, so the change log stays a single round trip rather than one per row.
  const priors = await db.transaction.findMany({
    where: { id: { in: transactionIds } },
    select: { id: true, merchantId: true, merchant: { select: { name: true } } },
  });

  await db.transaction.updateMany({
    where: { id: { in: transactionIds } },
    data: { merchantId: merchant?.id ?? null, merchantSource: "user" },
  });

  await recordUserChanges(
    db,
    priors
      .filter((prior) => prior.merchantId !== (merchant?.id ?? null))
      .map((prior) => ({
        transactionId: prior.id,
        field: "merchant" as const,
        fromId: prior.merchantId,
        fromLabel: prior.merchant?.name ?? null,
        toId: merchant?.id ?? null,
        toLabel: merchant?.name ?? null,
      })),
  );

  await db.transactionConflict.deleteMany({
    where: { transactionId: { in: transactionIds }, field: "merchant" },
  });

  await revalidateWorkspacePath(path);
}

export async function bulkSetCategory(
  transactionIds: string[],
  categoryId: string | null,
  path: string,
) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  if (transactionIds.length === 0) return;

  const category = categoryId
    ? await db.category.findUnique({ where: { id: categoryId }, select: { id: true, name: true, groupId: true } })
    : null;
  if (categoryId && !category) throw new Error(`Unknown category: ${categoryId}`);

  const priors = await db.transaction.findMany({
    where: { id: { in: transactionIds } },
    select: { id: true, categoryId: true, category: { select: { name: true } } },
  });

  await db.transaction.updateMany({
    where: { id: { in: transactionIds } },
    // Keep the denormalised group id in step with the category, as the single
    // setter does — the metrics that group by it depend on it.
    data: {
      categoryId: category?.id ?? null,
      categoryGroupId: category?.groupId ?? null,
      categorySource: "user",
    },
  });

  await recordUserChanges(
    db,
    priors
      .filter((prior) => prior.categoryId !== (category?.id ?? null))
      .map((prior) => ({
        transactionId: prior.id,
        field: "category" as const,
        fromId: prior.categoryId,
        fromLabel: prior.category?.name ?? null,
        toId: category?.id ?? null,
        toLabel: category?.name ?? null,
      })),
  );

  await db.transactionConflict.deleteMany({
    where: { transactionId: { in: transactionIds }, field: "category" },
  });

  await revalidateWorkspacePath(path);
}
