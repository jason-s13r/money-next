// Reconciliation between an enrichment field the sync must not touch — one a user
// or a rule owns — and what a later Akahu sync reports for it. Kept out of
// ./sync.ts so a review-queue page or a test can reuse it without pulling in the
// pipeline.
//
// No `server-only`: the sync worker imports this from plain Node, where it throws.

import type { ScopedDb } from "../db";
import type { Prisma, TransactionConflict } from "../../generated/prisma/client";

/** The enrichment fields a user or rule can own, and a sync can conflict with. */
export type EnrichmentField = "category" | "merchant";

/**
 * Decide what should happen to the conflict on one defended field, given the
 * value being held and the value Akahu now reports. The field itself is never
 * touched — the held value stands; this only manages the prompt to reconcile:
 *
 *   - Akahu reports a *different, non-null* value  → raise (or refresh) a conflict.
 *   - Akahu agrees, or reports nothing (null)       → clear any conflict.
 *
 * That second line is why extending this to rule-owned fields costs almost
 * nothing and adds almost no prompts: a rule usually exists precisely *because*
 * Akahu says nothing, and Akahu saying nothing has never been a conflict.
 *
 * A conflict the user already dismissed is only re-opened if Akahu's value has
 * changed *again* since it was dismissed — dismissing once shouldn't re-nag on
 * every sync.
 *
 * Returns a single write op to fold into the caller's batch, or null when there
 * is nothing to do (the common case: no conflict now, none before).
 */
export function reconcileConflict(
  db: ScopedDb,
  field: EnrichmentField,
  transactionId: string,
  /** What owns the held value: `user` or `rule`. See `TransactionConflict.heldSource`. */
  heldSource: string,
  userValueId: string | null,
  userValueLabel: string | null,
  akahuValueId: string | null,
  akahuValueLabel: string | null,
  existing: TransactionConflict | undefined,
): Prisma.PrismaPromise<unknown> | null {
  const diverges = akahuValueId !== null && akahuValueId !== userValueId;

  if (!diverges) {
    return existing ? db.transactionConflict.delete({ where: { id: existing.id } }) : null;
  }

  const data = { heldSource, userValueId, userValueLabel, akahuValueId, akahuValueLabel };

  if (!existing) {
    return db.transactionConflict.create({
      data: { workspaceId: db.$workspaceId, transactionId, field, status: "open", ...data },
    });
  }

  // Re-open only when Akahu has moved to a *new* value since we last recorded it.
  const reopened = existing.akahuValueId !== akahuValueId;
  return db.transactionConflict.update({
    where: { id: existing.id },
    data: reopened ? { ...data, status: "open" } : data,
  });
}
