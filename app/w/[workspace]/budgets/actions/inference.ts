"use server";

import { redirect } from "next/navigation";

import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { enqueueBudgetInference } from "@/lib/server/queue";
import { workspacePath } from "@/lib/workspace-path";
import { text } from "@/lib/form-data";
import { NO_ERROR, type BudgetActionState } from "../types";

export async function reinferBudget(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const { user } = await requireRole({ budget: ["update"] });
  const db = await getDb();

  const budget = await db.budget.findUnique({
    where: { id: text(form, "budgetId") },
    select: { id: true },
  });
  if (!budget) return { error: "That budget no longer exists." };

  await enqueueBudgetInference(db, { budgetId: budget.id, userId: user.id, clearBackoff: true });

  await revalidateWorkspacePath(`/budgets/${budget.id}`);
  return NO_ERROR;
}

export async function startBudgetInference(
  _prev: BudgetActionState,
  _form: FormData,
): Promise<BudgetActionState> {
  const { workspace, user } = await requireRole({ budget: ["update"] });
  const db = await getDb();

  await enqueueBudgetInference(db, { budgetId: null, userId: user.id, clearBackoff: true });

  await revalidateWorkspacePath("/budgets");
  redirect(workspacePath(workspace.slug, "/budgets"));
}

export async function clearInferenceRun(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const db = await getDb();
  await db.budgetInferenceRun.deleteMany({ where: { id: text(form, "runId") } });

  await revalidateWorkspacePath("/budgets");
  return NO_ERROR;
}

export async function retryInferenceRun(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const db = await getDb();
  await db.budgetInferenceRun.updateMany({
    where: { id: text(form, "runId"), status: "failed" },
    data: {
      status: "queued",
      attempts: 0,
      error: null,
      nextAttemptAt: null,
      finishedAt: null,
      startedAt: new Date(),
    },
  });

  await revalidateWorkspacePath("/budgets");
  return NO_ERROR;
}
