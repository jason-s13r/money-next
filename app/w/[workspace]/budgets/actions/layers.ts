"use server";

import { redirect } from "next/navigation";

import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { withScopedTx } from "@/lib/server/db/scoped";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { workspacePath } from "@/lib/workspace-path";
import { text, optionalId } from "@/lib/form-data";
import { NO_ERROR, type BudgetActionState } from "../types";
import { readLifespan, revalidateDashboard } from "./shared";

export async function duplicateBudget(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const { workspace } = await requireRole({ budget: ["update"] });

  const db = await getDb();
  const source = await db.budget.findUnique({
    where: { id: text(form, "budgetId") },
    select: {
      name: true,
      baseBudgetId: true,
      startsOn: true,
      endsOn: true,
      repeatsAnnually: true,
      items: {
        select: {
          name: true,
          amount: true,
          currency: true,
          categoryGroupId: true,
          categoryId: true,
          merchantId: true,
          frequency: true,
          interval: true,
          anchorDate: true,
        },
      },
    },
  });
  if (!source) return { error: "That budget no longer exists." };

  let baseBudgetId = source.baseBudgetId;
  const posted = optionalId(form, "baseBudgetId");
  if (posted) {
    const target = await db.budget.findUnique({
      where: { id: posted },
      select: { id: true, baseBudgetId: true },
    });
    if (!target) return { error: "Choose a base to duplicate this layer onto." };
    if (target.baseBudgetId) return { error: "A layer can’t be duplicated onto another layer." };
    baseBudgetId = target.id;
  }

  const name = `${source.name} (copy)`;

  const copyId = await withScopedTx(db, async (tx) => {
    const copy = await tx.budget.create({
      data: {
        workspaceId: db.$workspaceId,
        name,
        baseBudgetId,
        startsOn: source.startsOn,
        endsOn: source.endsOn,
        repeatsAnnually: source.repeatsAnnually,
      },
    });
    if (source.items.length) {
      await tx.budgetItem.createMany({
        data: source.items.map((item) => ({
          workspaceId: db.$workspaceId,
          budgetId: copy.id,
          ...item,
        })),
      });
    }
    return copy.id;
  });

  await revalidateWorkspacePath("/budgets");
  await revalidateDashboard();
  redirect(workspacePath(workspace.slug, `/budgets/${copyId}`));
}

export async function createLayer(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const { workspace } = await requireRole({ budget: ["update"] });

  const name = text(form, "name");
  if (!name) return { error: "Give the layer a name." };

  const lifespan = readLifespan(form);
  if ("error" in lifespan) return lifespan;

  const db = await getDb();
  const base = await db.budget.findUnique({
    where: { id: text(form, "baseBudgetId") },
    select: { id: true, baseBudgetId: true },
  });
  if (!base) return { error: "That base budget no longer exists." };
  if (base.baseBudgetId) return { error: "A layer can’t be added to another layer." };

  const layer = await db.budget.create({
    data: { workspaceId: db.$workspaceId, name, baseBudgetId: base.id, ...lifespan },
    select: { id: true },
  });

  await revalidateWorkspacePath("/budgets");
  await revalidateDashboard();
  redirect(workspacePath(workspace.slug, `/budgets/${layer.id}`));
}

export async function moveLayerToBase(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const db = await getDb();
  const layer = await db.budget.findUnique({
    where: { id: text(form, "budgetId") },
    select: { id: true, baseBudgetId: true },
  });
  if (!layer) return { error: "That budget no longer exists." };
  if (!layer.baseBudgetId) return { error: "Only a layer can be moved onto a base." };

  const target = await db.budget.findUnique({
    where: { id: text(form, "baseBudgetId") },
    select: { id: true, baseBudgetId: true },
  });
  if (!target) return { error: "Choose a base to move this layer onto." };
  if (target.baseBudgetId) return { error: "A layer can’t be moved onto another layer." };

  await db.budget.update({ where: { id: layer.id }, data: { baseBudgetId: target.id } });

  await revalidateWorkspacePath(`/budgets/${layer.id}`);
  await revalidateWorkspacePath("/budgets");
  await revalidateDashboard();
  return NO_ERROR;
}
