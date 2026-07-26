// The labels this app attaches on its own, rather than a person choosing them.
//
// They are plain `Label` rows, distinguished only by a reserved name — there is
// no `system` flag on the model — so they sit on `/labels` beside a user's own
// tags, and a user is free to rename or delete one. The next sync (or rule run)
// simply re-creates it by name, because these functions get-or-create rather
// than assume it exists.
//
// No `import "server-only"`: like changes.ts and the rules engine, this is
// reached from the plain-Node ingest worker as well as from a request, so it
// must not pull in the auth layer.

import { mintId } from "../ids";
import type { ScopedDb } from "./db";

/**
 * The tag every transaction receives the first time it is ingested, dated by the
 * day of the sync so each run's fresh arrivals are one findable group —
 * `ingested-2026-07-25`.
 *
 * The date is *when we received it*, not the transaction's own `date`: the tag
 * answers "what turned up in this sync?", and a transaction that settled last
 * week but only reached us today belongs to today's batch. UTC, matching the
 * balance-snapshot day (`startOfUtcDay`), so the grouping is deterministic
 * regardless of where the worker runs.
 */
export function ingestedLabelName(when: Date): string {
  return `ingested-${when.toISOString().slice(0, 10)}`;
}

/**
 * The tag a transaction receives whenever a rule run changes one of its fields.
 * A single standing tag rather than a dated one: it marks "a rule touched this,
 * worth a glance" — a bucket you clear as you review, not a per-run archive.
 */
export const RULE_TAGGED_LABEL = "rule-tagged";

/**
 * Get-or-create a workspace's label by name and return its id. Names are unique
 * per workspace, so a concurrent create loses on the constraint rather than
 * duplicating — caught and turned back into a read so the caller always gets an
 * id.
 *
 * Exported for `syncTransactions`, which resolves the id once per run and then
 * folds the tag write into each page's own atomic batch, rather than tagging in
 * a separate pass afterwards.
 */
export async function ensureLabelId(db: ScopedDb, name: string): Promise<string> {
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
 * Attach an auto-managed label (by name) to a set of transactions, idempotently.
 *
 * Skips any that already carry it so `createMany` never trips the composite PK,
 * and returns how many were newly tagged. Callers hold ids they know belong to
 * this workspace (the sync's own upserts, a rule run's own edits); the scoped
 * client filters and RLS-guards the writes regardless.
 */
export async function tagTransactions(
  db: ScopedDb,
  name: string,
  transactionIds: readonly string[],
): Promise<number> {
  if (transactionIds.length === 0) return 0;

  const labelId = await ensureLabelId(db, name);
  const already = await db.transactionLabel.findMany({
    where: { labelId, transactionId: { in: [...transactionIds] } },
    select: { transactionId: true },
  });
  const has = new Set(already.map((r) => r.transactionId));
  const toAdd = transactionIds.filter((id) => !has.has(id));
  if (toAdd.length === 0) return 0;

  await db.transactionLabel.createMany({
    data: toAdd.map((transactionId) => ({ workspaceId: db.$workspaceId, transactionId, labelId })),
  });
  return toAdd.length;
}
