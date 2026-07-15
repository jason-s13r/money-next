"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/server/db";

/**
 * Keep the user's value and stop nagging about this divergence. The conflict is
 * marked `dismissed` rather than deleted so the next sync — which will re-observe
 * the same disagreement — leaves it settled instead of re-raising it. If Akahu
 * later moves to a *new* value, the sync re-opens it (see `reconcileConflict`).
 */
export async function keepUserValue(conflictId: number) {
  const conflict = await db.transactionConflict.findUnique({ where: { id: conflictId } });
  if (!conflict) return;

  await db.transactionConflict.update({
    where: { id: conflictId },
    data: { status: "dismissed" },
  });

  revalidatePath(`/transactions/${conflict.transactionId}`);
}

/**
 * Take Akahu's value, handing ownership of the field back to the sync. The
 * denormalised `categoryGroupId` is refreshed from the catalog so the group stays
 * in step, `source` returns to `akahu`, and the conflict is cleared. The
 * merchant/category names themselves come from the joined rows, so there is
 * nothing to refresh there.
 */
export async function acceptAkahuValue(conflictId: number) {
  const conflict = await db.transactionConflict.findUnique({ where: { id: conflictId } });
  if (!conflict) return;

  const { transactionId, field, akahuValueId } = conflict;

  if (field === "category") {
    const category = akahuValueId
      ? await db.category.findUnique({ where: { id: akahuValueId } })
      : null;
    await db.transaction.update({
      where: { id: transactionId },
      data: {
        categoryId: akahuValueId,
        categoryGroupId: category?.groupId ?? null,
        categorySource: "akahu",
      },
    });
  } else {
    await db.transaction.update({
      where: { id: transactionId },
      data: {
        merchantId: akahuValueId,
        merchantSource: "akahu",
      },
    });
  }

  await db.transactionConflict.delete({ where: { id: conflictId } });

  revalidatePath(`/transactions/${transactionId}`);
}
