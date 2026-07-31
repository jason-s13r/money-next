"use server";

import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { getDisplayCurrency } from "@/lib/server/currency";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { text } from "@/lib/form-data";
import { NO_ERROR, type BudgetActionState } from "../types";
import { readItem } from "./shared";

export async function createBudgetItem(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const db = await getDb();
  const budget = await db.budget.findUnique({
    where: { id: text(form, "budgetId") },
    select: { id: true },
  });
  if (!budget) return { error: "That budget no longer exists." };

  const item = await readItem(form);
  if ("error" in item) return item;

  await db.budgetItem.create({
    data: {
      workspaceId: db.$workspaceId,
      budgetId: budget.id,
      currency: await getDisplayCurrency(),
      ...item,
    },
  });

  await revalidateWorkspacePath(`/budgets/${budget.id}`);
  return NO_ERROR;
}

export async function updateBudgetItem(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const db = await getDb();
  const existing = await db.budgetItem.findUnique({
    where: { id: text(form, "itemId") },
    select: { id: true, budgetId: true },
  });
  if (!existing) return { error: "That item no longer exists." };

  const item = await readItem(form);
  if ("error" in item) return item;

  await db.budgetItem.update({
    where: { id: existing.id },
    data: { ...item, inferred: false, inferredSource: null, basis: null },
  });

  await revalidateWorkspacePath(`/budgets/${existing.budgetId}`);
  return NO_ERROR;
}

export async function deleteBudgetItem(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const db = await getDb();
  const existing = await db.budgetItem.findUnique({
    where: { id: text(form, "itemId") },
    select: { id: true, budgetId: true },
  });
  if (!existing) return NO_ERROR;

  await db.budgetItem.delete({ where: { id: existing.id } });

  await revalidateWorkspacePath(`/budgets/${existing.budgetId}`);
  return NO_ERROR;
}
