// Reconciliation between a user-set enrichment field and what a later Akahu sync
// reports for it. Lives here rather than in scripts/ingest.ts so it can be reused
// (a review-queue page, tests) without importing the ingest entrypoint, which
// runs a sync on import.
//
// No `import "server-only"`: scripts/ingest.ts imports this from plain Node.

import { db } from "./db";
import type { Prisma, TransactionConflict } from "./generated/prisma/client";

/** The enrichment fields a user can own and a sync can therefore conflict with. */
export type EnrichmentField = "category" | "merchant";

/**
 * Decide what should happen to the conflict on one user-owned field, given the
 * value the user holds and the value Akahu now reports. The field itself is never
 * touched — the user's value stands; this only manages the prompt to reconcile:
 *
 *   - Akahu reports a *different, non-null* value  → raise (or refresh) a conflict.
 *   - Akahu agrees, or reports nothing (null)       → clear any conflict.
 *
 * A conflict the user already dismissed is only re-opened if Akahu's value has
 * changed *again* since it was dismissed — dismissing once shouldn't re-nag on
 * every sync.
 *
 * Returns a single write op to fold into the caller's batch, or null when there
 * is nothing to do (the common case: no conflict now, none before).
 */
export function reconcileConflict(
  field: EnrichmentField,
  transactionId: string,
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

  const data = { userValueId, userValueLabel, akahuValueId, akahuValueLabel };

  if (!existing) {
    return db.transactionConflict.create({
      data: { transactionId, field, status: "open", ...data },
    });
  }

  // Re-open only when Akahu has moved to a *new* value since we last recorded it.
  const reopened = existing.akahuValueId !== akahuValueId;
  return db.transactionConflict.update({
    where: { id: existing.id },
    data: reopened ? { ...data, status: "open" } : data,
  });
}
