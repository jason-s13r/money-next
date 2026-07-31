"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { recordUserChanges } from "@/lib/server/changes";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { withScopedTx } from "@/lib/server/db";

/**
 * Keep the user's value and stop nagging about this divergence. The conflict is
 * marked `dismissed` rather than deleted so the next sync — which will re-observe
 * the same disagreement — leaves it settled instead of re-raising it. If Akahu
 * later moves to a *new* value, the sync re-opens it (see `reconcileConflict`).
 *
 * Nothing goes in the field change log: the field does not change. The user's
 * value stays exactly as their earlier edit — which *is* in the log — left it.
 * Dismissing a conflict is a statement about the conflict, not about the field.
 */
export async function keepUserValue(conflictId: number) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  const conflict = await db.transactionConflict.findUnique({ where: { id: conflictId } });
  if (!conflict) return;

  await db.transactionConflict.update({
    where: { id: conflictId },
    data: { status: "dismissed" },
  });

  await revalidateWorkspacePath(`/transactions/${conflict.transactionId}`);
}

/**
 * Take Akahu's value and clear the conflict. The denormalised `categoryGroupId` is
 * refreshed from the catalog so the group stays in step. The merchant/category
 * names themselves come from the joined rows, so there is nothing to refresh there.
 *
 * What the field's `source` becomes depends on what was holding it, and the two
 * answers are not a preference — each is the only one that settles:
 *
 *   - A **user**-held field hands ownership back to the sync (`akahu`). The user
 *     is saying "stop overriding, just track Akahu", and nothing else writes the
 *     field, so it stays tracking.
 *   - A **rule**-held field must become `user` instead. Handing it to `akahu`
 *     would settle nothing: the rules run on the next sync, see a field they
 *     outrank, set their value back and stamp `rule` — and the sync after that
 *     raises the same conflict again. A rule is a standing instruction, so the
 *     only way to say "not this row" is to outrank it, and `user` is what
 *     outranks it. The rule keeps applying everywhere else, which is the point.
 *
 * Logged as a `user` change either way, even though the value written is Akahu's:
 * the question the log answers is who *decided*, and a person did — the sync had
 * been refused this write for as long as the conflict stood. The conflict row
 * already holds both sides, so this is the one writer needing no extra read to
 * know what the field was.
 *
 * Not routed through `applyEnrichment` despite the family resemblance, and the
 * three differences are each the point of this action rather than incidental: the
 * value written is Akahu's and the `source` it is stamped with is computed above
 * (`applyEnrichment` always stamps `user`, which is what makes it the *manual*
 * setter); the conflict is resolved by its own id rather than by field, so
 * settling one leaves any other alone; and the prior value is read off the
 * conflict row instead of the transaction. What it does share is the requirement
 * that all of it commit together, which is the transaction below.
 */
export async function acceptAkahuValue(conflictId: number) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  const conflict = await db.transactionConflict.findUnique({ where: { id: conflictId } });
  if (!conflict) return;

  const { transactionId, field, akahuValueId, heldSource } = conflict;
  const source = heldSource === "rule" ? "user" : "akahu";

  // Resolved before the transaction opens: a catalog read that the write doesn't
  // touch has no business holding the connection.
  const category =
    field === "category" && akahuValueId
      ? await db.category.findUnique({ where: { id: akahuValueId }, select: { groupId: true } })
      : null;

  await withScopedTx(db, async (tx) => {
    await tx.transaction.update({
      where: { id: transactionId },
      data:
        field === "category"
          ? {
              categoryId: akahuValueId,
              categoryGroupId: category?.groupId ?? null,
              categorySource: source,
            }
          : { merchantId: akahuValueId, merchantSource: source },
    });

    if (conflict.userValueId !== akahuValueId) {
      await recordUserChanges(tx, [
        {
          transactionId,
          field: field === "category" ? "category" : "merchant",
          fromId: conflict.userValueId,
          fromLabel: conflict.userValueLabel,
          toId: akahuValueId,
          toLabel: conflict.akahuValueLabel,
        },
      ]);
    }

    await tx.transactionConflict.delete({ where: { id: conflictId } });
  });

  await revalidateWorkspacePath(`/transactions/${transactionId}`);
}
