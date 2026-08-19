// The one label the app writes for itself: the tag a rule was *configured* to
// apply. That is a person's choice expressed in a rule, not an app-managed tag.
//
// The sync's `ingested-<date>` and the rules engine's derived `category-rule-*`
// both used to live here. They answered "which run did this?" with a name, and a
// transaction now links to its run directly (`Transaction.syncRunId`,
// `FieldChange.ruleRunId`/`syncRunId`), so they were dropped. Existing ones stay
// in the database as ordinary labels.
//
// No `import "server-only"`: like changes.ts and the rules engine, this is
// reached from the plain-Node ingest worker as well as from a request, so it
// must not pull in the auth layer.

import { mintId } from "../ids";
import type { ScopedDb } from "./db";

/**
 * Get-or-create a workspace's label by name and return its id. Names are unique
 * per workspace, so a concurrent create loses on the constraint rather than
 * duplicating — caught and turned back into a read so the caller always gets an
 * id.
 */
async function ensureLabelId(db: ScopedDb, name: string): Promise<string> {
  const existing = await db.label.findUnique({
    where: { workspaceId_name: { workspaceId: db.$workspaceId, name } },
    select: { id: true },
  });
  if (existing) return existing.id;

  try {
    const created = await db.label.create({
      data: { id: mintId("label"), workspaceId: db.$workspaceId, name },
      select: { id: true },
    });
    return created.id;
  } catch {
    const row = await db.label.findUniqueOrThrow({
      where: { workspaceId_name: { workspaceId: db.$workspaceId, name } },
      select: { id: true },
    });
    return row.id;
  }
}

/**
 * Attach a rule's configured label (by name) to a set of transactions, idempotently.
 *
 * Skips any that already carry it so `createMany` never trips the composite PK,
 * and returns the ids it *newly* tagged — not a count, because a caller that logs
 * the tag needs to know which ones it actually happened to. Without that, a rule
 * run that touched a transaction a second time would log a label it applied last
 * week, and the change log's one invariant is that a row means something changed.
 *
 * The caller holds ids it knows belong to this workspace (a rule run's own
 * edits); the scoped client filters and RLS-guards the writes regardless.
 */
export async function tagTransactions(
  db: ScopedDb,
  name: string,
  transactionIds: readonly string[],
): Promise<string[]> {
  if (transactionIds.length === 0) return [];

  const labelId = await ensureLabelId(db, name);
  const already = await db.transactionLabel.findMany({
    where: { labelId, transactionId: { in: [...transactionIds] } },
    select: { transactionId: true },
  });
  const has = new Set(already.map((r) => r.transactionId));
  const toAdd = transactionIds.filter((id) => !has.has(id));
  if (toAdd.length === 0) return [];

  await db.transactionLabel.createMany({
    data: toAdd.map((transactionId) => ({ workspaceId: db.$workspaceId, transactionId, labelId })),
  });
  return toAdd;
}
