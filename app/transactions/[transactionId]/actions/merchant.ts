"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/server/db";

export async function setTransactionMerchant(
  transactionId: string,
  merchantId: string | null,
) {
  if (merchantId === null) {
    await db.transaction.update({
      where: { id: transactionId },
      data: { merchantId: null, merchantSource: "user" },
    });
  } else {
    const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) throw new Error(`Unknown merchant: ${merchantId}`);
    await db.transaction.update({
      where: { id: transactionId },
      data: { merchantId: merchant.id, merchantSource: "user" },
    });
  }

  await db.transactionConflict.deleteMany({ where: { transactionId, field: "merchant" } });

  revalidatePath(`/transactions/${transactionId}`);
}

/**
 * Create a brand-new merchant from the transaction details page and assign it to
 * the transaction. User-created merchants get a `user_...` id so they never
 * collide with Akahu's `merchant_...` ids, and the field is marked `user`-owned
 * so a later sync won't overwrite it.
 */
export async function createMerchantAndSetForTransaction(
  transactionId: string,
  name: string,
) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Merchant name is required");

  const merchant = await db.merchant.create({
    data: {
      id: `user_${randomUUID().replace(/-/g, "")}`,
      name: trimmed,
    },
  });

  await db.transaction.update({
    where: { id: transactionId },
    data: {
      merchantId: merchant.id,
      merchantSource: "user",
    },
  });

  await db.transactionConflict.deleteMany({ where: { transactionId, field: "merchant" } });

  revalidatePath(`/transactions/${transactionId}`);
}

// Bulk version of the single setter, for applying this transaction's chosen
// merchant to the list of similar transactions on the same page.

export async function applyMerchantToTransactions(
  sourceId: string,
  merchantId: string,
  transactionIds: string[],
) {
  if (transactionIds.length === 0) return;

  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw new Error(`Unknown merchant: ${merchantId}`);

  await db.transaction.updateMany({
    where: { id: { in: transactionIds } },
    data: { merchantId: merchant.id, merchantSource: "user" },
  });

  await db.transactionConflict.deleteMany({
    where: { transactionId: { in: transactionIds }, field: "merchant" },
  });

  revalidatePath(`/transactions/${sourceId}`);
}
