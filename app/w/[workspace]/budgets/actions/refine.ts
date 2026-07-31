"use server";

import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { withScopedTx } from "@/lib/server/db/scoped";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { computeRefinements } from "@/lib/server/budget/refine";
import { text } from "@/lib/form-data";
import { NO_ERROR, type BudgetActionState } from "../types";
import { revalidateDashboard } from "./shared";

export async function refineBudgetTowardActuals(
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

  const refinements = await computeRefinements(budget.id);
  if (refinements.length === 0) {
    return {
      error: "Nothing to refine — no recent transactions match this budget's items.",
    };
  }

  await withScopedTx(db, async (tx) => {
    for (const { id, to } of refinements) {
      await tx.budgetItem.update({ where: { id }, data: { amount: to } });
    }
  });

  await revalidateWorkspacePath(`/budgets/${budget.id}`);
  await revalidateWorkspacePath("/budgets");
  await revalidateDashboard();
  return NO_ERROR;
}
