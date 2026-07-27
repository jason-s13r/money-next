"use server";

import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { withScopedTx } from "@/lib/server/db/scoped";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { enqueueBudgetInference } from "@/lib/server/queue";
import { SCENARIO_COLORS } from "@/lib/server/metrics/budget/forecast";
import { slugify } from "@/lib/slug";
import { NO_ERROR, type BudgetActionState } from "../budgets/types";

// Server actions behind `/forecasts`.
//
// Same rules as the budget actions next door, for the same reasons: every one
// opens with `requireRole({ budget: ["update"] })` because a server action is a
// public POST endpoint (`tests/actions.test.ts` fails the build if a gate goes
// missing), every posted id is re-resolved through the scoped client rather than
// trusted, and anything that writes more than one row does it inside one
// `withScopedTx` so a write is never half-made.
//
// A forecast reuses `budget: ["update"]` rather than gaining a statement of its
// own: a forecast is a view *of* a budget, and someone who may not change a budget
// has no business deciding which one the forecast projects.

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

/** A forecast slug unique within the workspace, `-2`/`-3`… appended on collision. */
async function uniqueForecastSlug(name: string): Promise<string> {
  const db = await getDb();
  const base = slugify(name) || "forecast";
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    // findFirst, not findUnique: a slug is unique only within a workspace, and
    // the scoped client supplies the other half of that key.
    const clash = await db.forecast.findFirst({ where: { slug }, select: { id: true } });
    if (!clash) return slug;
  }
}

/** The first palette colour nobody has taken, so a new forecast is distinguishable
 *  from its neighbours at a glance. Past the end of the palette it wraps — eight
 *  lines on one chart is already more than anyone can read. */
async function nextColor(): Promise<string> {
  const db = await getDb();
  const existing = await db.forecast.findMany({ select: { color: true } });
  const taken = new Set(existing.map((f) => f.color));
  return (
    SCENARIO_COLORS.find((c) => !taken.has(c)) ??
    SCENARIO_COLORS[existing.length % SCENARIO_COLORS.length]
  );
}

/** The end of the current order, so a new forecast lands last. */
async function nextPosition(): Promise<number> {
  const db = await getDb();
  const rows = await db.forecast.findMany({ select: { position: true } });
  return rows.length ? Math.max(...rows.map((r) => r.position)) + 1 : 0;
}

/** Everything a forecast change makes stale: the page itself, and the dashboard
 *  whose chart and runway tiles are drawn from these forecasts. */
async function revalidateForecasts() {
  await revalidateWorkspacePath("/forecasts");
  await revalidateWorkspacePath("/");
}

/**
 * Queue a re-inference of a budget from the last two years of transactions.
 *
 * The work itself — which talks to the LLM and can take a minute or more — runs in
 * the worker, so this only enqueues and returns; the budget page shows it in flight
 * and refreshes when the row settles. The worker replaces only rows still marked
 * `inferred`, leaving anything hand-edited alone: on a locked inferred budget nothing
 * is hand-edited, so it rebuilds whole; on a duplicated `user` copy it spares edits.
 */
export async function reinferBudget(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });
  const db = await getDb();

  const budget = await db.budget.findUnique({
    where: { id: text(form, "budgetId") },
    select: { id: true, slug: true },
  });
  if (!budget) return { error: "That budget no longer exists." };

  await enqueueBudgetInference(db, { budgetId: budget.id, clearBackoff: true });

  await revalidateWorkspacePath(`/budgets/${budget.slug}`);
  await revalidateForecasts();
  return NO_ERROR;
}

/**
 * Create a forecast over one budget.
 *
 * The budget id is re-resolved through the scoped client, so an id naming another
 * workspace's budget finds nothing and the forecast is not created rather than
 * pointing across the tenant boundary.
 */
export async function createForecast(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const name = text(form, "name");
  if (!name) return { error: "Give the forecast a name." };

  const db = await getDb();
  // A forecast projects a base together with its layers, so it must point at a
  // base, not a bare layer — re-resolved through the scoped client and checked here
  // rather than trusting the picker.
  const budget = await db.budget.findUnique({
    where: { id: text(form, "budgetId") },
    select: { id: true, baseBudgetId: true },
  });
  if (!budget) return { error: "Choose a budget for this forecast to project." };
  if (budget.baseBudgetId) return { error: "A forecast projects a base, not a layer." };

  await db.forecast.create({
    data: {
      workspaceId: db.$workspaceId,
      name,
      slug: await uniqueForecastSlug(name),
      color: await nextColor(),
      position: await nextPosition(),
      budgetId: budget.id,
    },
  });

  await revalidateForecasts();
  return NO_ERROR;
}

/**
 * Rename a forecast and/or change the budget it projects.
 *
 * The posted budget id is re-resolved through the scoped client, so an id naming
 * another workspace's budget silently does nothing rather than being projected into
 * this one's forecast.
 */
export async function updateForecast(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const name = text(form, "name");
  if (!name) return { error: "Give the forecast a name." };

  const db = await getDb();
  const forecast = await db.forecast.findUnique({
    where: { id: text(form, "forecastId") },
    select: { id: true },
  });
  if (!forecast) return { error: "That forecast no longer exists." };

  const budget = await db.budget.findUnique({
    where: { id: text(form, "budgetId") },
    select: { id: true, baseBudgetId: true },
  });
  if (!budget) return { error: "Choose a budget for this forecast to project." };
  if (budget.baseBudgetId) return { error: "A forecast projects a base, not a layer." };

  await db.forecast.update({
    where: { id: forecast.id },
    data: { name, budgetId: budget.id },
  });

  await revalidateForecasts();
  return NO_ERROR;
}

export async function deleteForecast(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const db = await getDb();
  // deleteMany, not delete: a no-op on an id this workspace does not own, where
  // `delete` would throw on the missing row and say so. The budget it projected is
  // untouched — a forecast is a view of a budget, and deleting a view must not
  // delete what it looked at.
  await db.forecast.deleteMany({ where: { id: text(form, "forecastId") } });

  await revalidateForecasts();
  return NO_ERROR;
}

/**
 * Move a forecast one place up or down.
 *
 * Positions are rewritten from the resulting order rather than swapped in place, so
 * a set that arrived with duplicate or gapped positions (an import, a partial
 * delete) comes out contiguous instead of preserving the mess.
 */
export async function moveForecast(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const db = await getDb();
  const forecasts = await db.forecast.findMany({
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { id: true },
  });

  const index = forecasts.findIndex((f) => f.id === text(form, "forecastId"));
  if (index === -1) return { error: "That forecast no longer exists." };

  const target = text(form, "direction") === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= forecasts.length) return NO_ERROR;

  const ordered = [...forecasts];
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];

  await withScopedTx(db, async (tx) => {
    for (const [position, forecast] of ordered.entries()) {
      await tx.forecast.update({ where: { id: forecast.id }, data: { position } });
    }
  });

  await revalidateForecasts();
  return NO_ERROR;
}
