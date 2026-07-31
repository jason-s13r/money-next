"use server";

import { redirect } from "next/navigation";

import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { workspacePath } from "@/lib/workspace-path";
import { text } from "@/lib/form-data";
import { NO_ERROR, type BudgetActionState } from "../types";
import { readLifespan, revalidateDashboard } from "./shared";

export async function createBudget(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const { workspace } = await requireRole({ budget: ["update"] });

  const name = text(form, "name");
  if (!name) return { error: "Give the budget a name." };

  const lifespan = readLifespan(form);
  if ("error" in lifespan) return lifespan;

  const forecast = form.get("forecast") === "on";

  const db = await getDb();
  const budget = await db.budget.create({
    data: { workspaceId: db.$workspaceId, name, forecast, ...lifespan },
    select: { id: true },
  });

  await revalidateWorkspacePath("/budgets");
  await revalidateDashboard();
  redirect(workspacePath(workspace.slug, `/budgets/${budget.id}`));
}

export async function updateBudget(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const id = text(form, "budgetId");
  const name = text(form, "name");
  if (!name) return { error: "Give the budget a name." };

  const lifespan = readLifespan(form);
  if ("error" in lifespan) return lifespan;

  const forecast = form.get("forecast") === "on";

  const db = await getDb();
  const budget = await db.budget.findUnique({ where: { id }, select: { id: true } });
  if (!budget) return { error: "That budget no longer exists." };

  await db.budget.update({ where: { id: budget.id }, data: { name, forecast, ...lifespan } });

  await revalidateWorkspacePath(`/budgets/${budget.id}`);
  await revalidateWorkspacePath("/budgets");
  await revalidateDashboard();
  return NO_ERROR;
}

export async function deleteBudget(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const { workspace } = await requireRole({ budget: ["update"] });

  const db = await getDb();
  await db.budget.deleteMany({ where: { id: text(form, "budgetId") } });

  await revalidateWorkspacePath("/budgets");
  await revalidateDashboard();
  redirect(workspacePath(workspace.slug, "/budgets"));
}

export async function toggleBudgetForecast(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const db = await getDb();
  const budget = await db.budget.findUnique({
    where: { id: text(form, "budgetId") },
    select: { id: true, baseBudgetId: true, forecast: true },
  });
  if (!budget) return { error: "That budget no longer exists." };
  if (budget.baseBudgetId) return { error: "Only a base budget can be a forecast." };

  await db.budget.update({
    where: { id: budget.id },
    data: { forecast: !budget.forecast },
  });

  await revalidateWorkspacePath(`/budgets/${budget.id}`);
  await revalidateWorkspacePath("/budgets");
  await revalidateDashboard();
  return NO_ERROR;
}
