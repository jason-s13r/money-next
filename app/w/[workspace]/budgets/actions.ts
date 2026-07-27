"use server";

import { redirect } from "next/navigation";

import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { withScopedTx } from "@/lib/server/db/scoped";
import { getDisplayCurrency } from "@/lib/server/currency";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { enqueueBudgetInference } from "@/lib/server/queue";
import { computeRefinements } from "@/lib/server/budget/refine";
import { workspacePath } from "@/lib/workspace-path";
import { isFrequency } from "@/lib/budget/recurrence";
import { slugify } from "@/lib/slug";
import { NO_ERROR, type BudgetActionState } from "./types";

// Server actions behind `/budgets`.
//
// Every one opens with `requireRole({ budget: ["update"] })`. That is not
// ceremony: a server action is a public POST endpoint with a stable id, and
// anything on the internet can call it with any arguments it likes — which is
// also why the ids in a form are resolved through the scoped client below rather
// than trusted. `tests/actions.test.ts` scans this file and fails the build if a
// gate goes missing.
//
// A budget is not enrichment, so it has its own statement rather than borrowing
// `enrichment: ["update"]` — see lib/server/auth/roles.ts.

/** A slug unique within the workspace, `-2`/`-3`… appended on collision. */
async function uniqueSlug(name: string, fallback: string, exceptId?: string): Promise<string> {
  const db = await getDb();
  const base = slugify(name) || fallback;
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    // findFirst, not findUnique: a slug is unique only within a workspace, and
    // the scoped client supplies the other half of that key.
    const clash = await db.budget.findFirst({ where: { slug }, select: { id: true } });
    if (!clash || clash.id === exceptId) return slug;
  }
}

/**
 * A `YYYY-MM-DD` from a date input, as UTC midnight.
 *
 * UTC midnight is the representation the recurrence module uses for an NZ
 * calendar day throughout: NZ leads UTC by 12–13 hours, so UTC midnight always
 * resolves back to the same NZ day. Parsing the parts rather than handing the
 * string to `new Date` keeps that explicit instead of relying on the spec's
 * date-only rule.
 */
function parseDay(value: FormDataEntryValue | null): Date | null {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 February and friends, which `Date.UTC` would silently roll over.
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

/** An optional id field: empty string means "not set", not "the empty id". */
const optionalId = (form: FormData, key: string) => text(form, key) || null;

/** The forecasts page and the dashboard both draw from budgets, so a change to
 *  which base a layer belongs to (or a duplicate that lands on a base) makes their
 *  projected lines stale. */
async function revalidateForecasts() {
  await revalidateWorkspacePath("/forecasts");
  await revalidateWorkspacePath("/");
}

// An inferred budget is edited in place, like any other — no lock, no forced
// duplicate. What keeps a re-infer from clobbering a hand-edit is the per-item
// `inferred` flag: the seeder writes it true, the first edit to a row clears it
// (see `updateBudgetItem`), and `refreshInferred` only rebuilds rows still marked
// inferred. So an edited figure survives a re-infer while an untouched guess is
// refreshed — the sparing that the old read-only snapshot achieved by refusing
// edits outright, now achieved without refusing them.

/** The lifespan columns from a budget form, or a message saying what is wrong. */
function readLifespan(form: FormData): { error: string } | {
  startsOn: Date | null;
  endsOn: Date | null;
  repeatsAnnually: boolean;
} {
  // "always" is the general daily-living budget: no bounds at all.
  if (text(form, "lifespan") !== "window") {
    return { startsOn: null, endsOn: null, repeatsAnnually: false };
  }

  const startsOn = parseDay(form.get("startsOn"));
  const endsOn = parseDay(form.get("endsOn"));
  if (!startsOn || !endsOn) {
    return { error: "A budget with a window needs both a start and an end date." };
  }

  const repeatsAnnually = form.get("repeatsAnnually") === "on";
  // A window that runs backwards is almost always a typo — except when it repeats
  // annually, where start-after-end is exactly how a window that wraps the New
  // Year is written (15 Dec – 5 Jan), and rejecting it would forbid the single
  // most obvious seasonal budget there is.
  if (!repeatsAnnually && endsOn < startsOn) {
    return { error: "The end date is before the start date." };
  }

  return { startsOn, endsOn, repeatsAnnually };
}

export async function createBudget(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const { workspace } = await requireRole({ budget: ["update"] });

  const name = text(form, "name");
  if (!name) return { error: "Give the budget a name." };

  const lifespan = readLifespan(form);
  if ("error" in lifespan) return lifespan;

  const db = await getDb();
  const slug = await uniqueSlug(name, "budget");
  await db.budget.create({
    data: { workspaceId: db.$workspaceId, name, slug, ...lifespan },
  });

  await revalidateWorkspacePath("/budgets");
  // Outside the try/catch there isn't one — `redirect` works by throwing, and
  // catching it would turn every successful create into an error message.
  redirect(workspacePath(workspace.slug, `/budgets/${slug}`));
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

  const db = await getDb();
  // Through the scoped client, so an id naming another workspace's budget finds
  // nothing rather than being updated.
  const budget = await db.budget.findUnique({ where: { id }, select: { id: true, slug: true } });
  if (!budget) return { error: "That budget no longer exists." };

  await db.budget.update({ where: { id: budget.id }, data: { name, ...lifespan } });

  await revalidateWorkspacePath(`/budgets/${budget.slug}`);
  await revalidateWorkspacePath("/budgets");
  return NO_ERROR;
}

export async function deleteBudget(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  const { workspace } = await requireRole({ budget: ["update"] });

  const db = await getDb();
  // deleteMany, not delete: it is a no-op on an id this workspace does not own,
  // where `delete` would throw on the missing row and say so.
  await db.budget.deleteMany({ where: { id: text(form, "budgetId") } });

  await revalidateWorkspacePath("/budgets");
  redirect(workspacePath(workspace.slug, "/budgets"));
}

/**
 * Validate an item form against what this workspace can actually see.
 *
 * Every id is resolved through the scoped client rather than taken at face
 * value. The category group and category come from shared catalogs so the check
 * is only that they exist; the merchant is half tenant data, and `scopedDb`'s
 * merchant filter is what stops one workspace filing a budget item against
 * another's private merchant.
 */
async function readItem(form: FormData): Promise<{ error: string } | {
  name: string;
  amount: number;
  categoryGroupId: string;
  categoryId: string | null;
  merchantId: string | null;
  frequency: string;
  interval: number;
  anchorDate: Date;
}> {
  const db = await getDb();

  const name = text(form, "name");
  if (!name) return { error: "Give the item a name." };

  const magnitude = Number(text(form, "amount"));
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return { error: "Enter an amount greater than zero." };
  }
  // The form asks for a direction and a positive figure; the sign is applied
  // here, so `amount` is stored signed like `Transaction.amount` and nobody has
  // to type a minus. Income is positive, money out is negative.
  const amount = text(form, "direction") === "income" ? magnitude : -magnitude;

  const frequency = text(form, "frequency");
  if (!isFrequency(frequency)) return { error: "Choose how often this happens." };

  const interval = Number(text(form, "interval") || "1");
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    return { error: "The repeat interval must be a whole number between 1 and 365." };
  }

  const anchorDate = parseDay(form.get("anchorDate"));
  if (!anchorDate) return { error: "Choose the date this happens on." };

  const categoryGroupId = text(form, "categoryGroupId");
  if (!categoryGroupId) return { error: "Choose a category group." };
  const group = await db.categoryGroup.findUnique({
    where: { id: categoryGroupId },
    select: { id: true },
  });
  if (!group) return { error: "That category group no longer exists." };

  const categoryId = optionalId(form, "categoryId");
  if (categoryId) {
    const category = await db.category.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (!category) return { error: "That category no longer exists." };
  }

  const merchantId = optionalId(form, "merchantId");
  if (merchantId) {
    const merchant = await db.merchant.findUnique({ where: { id: merchantId }, select: { id: true } });
    if (!merchant) return { error: "That merchant no longer exists." };
  }

  return { name, amount, categoryGroupId, categoryId, merchantId, frequency, interval, anchorDate };
}

export async function createBudgetItem(
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

  const item = await readItem(form);
  if ("error" in item) return item;

  await db.budgetItem.create({
    data: {
      workspaceId: db.$workspaceId,
      budgetId: budget.id,
      // Stamped at creation from whichever currency the workspace totals in. See
      // the column's note: without it, a later shift in the display currency
      // would silently reinterpret every figure already typed.
      currency: await getDisplayCurrency(),
      ...item,
    },
  });

  await revalidateWorkspacePath(`/budgets/${budget.slug}`);
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
    select: { id: true, budget: { select: { slug: true } } },
  });
  if (!existing) return { error: "That item no longer exists." };

  const item = await readItem(form);
  if ("error" in item) return item;

  await db.budgetItem.update({
    where: { id: existing.id },
    // A hand-edited row is no longer a guess, so it stops being one the "re-infer
    // from history" pass may overwrite. That is the whole job of `inferred`.
    data: { ...item, inferred: false },
  });

  await revalidateWorkspacePath(`/budgets/${existing.budget.slug}`);
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
    select: { id: true, budget: { select: { slug: true } } },
  });
  if (!existing) return NO_ERROR;

  await db.budgetItem.delete({ where: { id: existing.id } });

  await revalidateWorkspacePath(`/budgets/${existing.budget.slug}`);
  return NO_ERROR;
}

/**
 * Queue an AI inference that builds a budget from history, and return to the list.
 *
 * The work is slow — it talks to a local LLM over several windows of history — so it
 * runs in the worker, not here: this enqueues a `BudgetInferenceRun` and redirects.
 * The budgets page shows the run in flight ("being created") and the finished budget
 * appears there when the worker is done. Nothing is reviewed first, by design: the
 * result is an ordinary budget you then edit, re-infer, or refine in place — the
 * before-commit review the earlier synchronous flow had is gone with it.
 */
export async function startBudgetInference(
  _prev: BudgetActionState,
  _form: FormData,
): Promise<BudgetActionState> {
  const { workspace } = await requireRole({ budget: ["update"] });
  const db = await getDb();

  // A create run coalesces with any other queued create (budgetId null), so a
  // double-click makes one budget, not two.
  await enqueueBudgetInference(db, { budgetId: null, clearBackoff: true });

  await revalidateWorkspacePath("/budgets");
  redirect(workspacePath(workspace.slug, "/budgets"));
}

/**
 * Clear an inference run off the "being created" list, whatever state it is in.
 *
 * `deleteMany`, so it is a no-op on an id this workspace does not own. Any status is
 * fair game — a failed run, but also one stalled `queued` with no worker running, or
 * one wedged `running` because a worker died. Clearing a run the worker is genuinely
 * still on is harmless: the worker's finalise is an `updateMany` that no-ops on the
 * now-missing row, and any budget it had already built stays. It does not interrupt
 * in-flight work — it only stops tracking it.
 */
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

/**
 * Re-queue a failed inference to try again, in place.
 *
 * Only a `failed` run: it keeps its target — a create stays a create, a re-infer
 * still names the same budget — with the attempt count and retry backoff reset so
 * the worker takes it fresh. A `running` run is deliberately untouched (re-queuing
 * one a worker is on would let it run twice); to force that, Clear it and start over.
 */
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

/**
 * Duplicate a budget, items and all — optionally onto a different base.
 *
 * The answer to "next Christmas is much like this one": a seasonal layer that does
 * *not* repeat annually is otherwise retyped from scratch each year, and a copy can
 * land on a different base than the original (next year's plan). With no target
 * posted, the copy keeps the source's own role: a base duplicates to a base, a layer
 * to a layer under the same base. One transaction, so a copy is never left half-made.
 */
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

  // Default: the copy keeps the source's role. An explicit target re-homes a layer
  // onto another base — re-resolved through the scoped client, and refused if it is
  // itself a layer (one level only).
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
  const slug = await uniqueSlug(name, "budget");

  await withScopedTx(db, async (tx) => {
    const copy = await tx.budget.create({
      data: {
        workspaceId: db.$workspaceId,
        name,
        slug,
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
  });

  await revalidateWorkspacePath("/budgets");
  await revalidateForecasts();
  redirect(workspacePath(workspace.slug, `/budgets/${slug}`));
}

/**
 * Create a layer on a base budget.
 *
 * A layer holds only the *extra* a period needs, added on top of its base while its
 * own window is live — so it usually carries a window (a Christmas layer, a holiday
 * trip). The posted base id is re-resolved through the scoped client and must be a
 * real base: a layer cannot layer onto another layer (one level only).
 */
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

  const slug = await uniqueSlug(name, "layer");
  await db.budget.create({
    data: { workspaceId: db.$workspaceId, name, slug, baseBudgetId: base.id, ...lifespan },
  });

  await revalidateWorkspacePath("/budgets");
  await revalidateForecasts();
  redirect(workspacePath(workspace.slug, `/budgets/${slug}`));
}

/**
 * Move a layer onto a different base.
 *
 * Both ids are re-resolved through the scoped client. The moved budget must be a
 * layer and the target must be a base — the same one-level rule the create path
 * enforces. Changing which base a layer belongs to changes which forecast includes
 * it, so the forecasts and dashboard are revalidated alongside the budget pages.
 */
export async function moveLayerToBase(
  _prev: BudgetActionState,
  form: FormData,
): Promise<BudgetActionState> {
  await requireRole({ budget: ["update"] });

  const db = await getDb();
  const layer = await db.budget.findUnique({
    where: { id: text(form, "budgetId") },
    select: { id: true, slug: true, baseBudgetId: true },
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

  await revalidateWorkspacePath(`/budgets/${layer.slug}`);
  await revalidateWorkspacePath("/budgets");
  await revalidateForecasts();
  return NO_ERROR;
}

/**
 * Nudge a budget's figures toward recent actuals: `budgeted = mean(budgeted,
 * actual)`, item by item.
 *
 * A maintenance pass, not a hand-edit — the counterpart to "re-infer from history":
 * where re-infer rebuilds the items from scratch, this keeps them and reinforces
 * their amounts toward what has continued to happen. It deliberately leaves the
 * `inferred` flag alone (it is not someone confirming a figure), so a later re-infer
 * still treats an untouched-by-hand row as a guess. Items the recent window does not
 * speak to are left exactly as they are (see `computeRefinements`).
 */
export async function refineBudgetTowardActuals(
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

  const refinements = await computeRefinements(budget.id);
  if (refinements.length === 0) {
    return {
      error: "Nothing to refine — no recent transactions match this budget's items.",
    };
  }

  await withScopedTx(db, async (tx) => {
    for (const { id, to } of refinements) {
      // Resolved through the scoped tx; the ids came from this budget's own items,
      // so there is nothing across the tenant boundary to reach in the first place.
      await tx.budgetItem.update({ where: { id }, data: { amount: to } });
    }
  });

  await revalidateWorkspacePath(`/budgets/${budget.slug}`);
  await revalidateWorkspacePath("/budgets");
  // The amounts drive the projection too, so the dashboard and forecasts are stale.
  await revalidateWorkspacePath("/forecasts");
  await revalidateWorkspacePath("/");
  return NO_ERROR;
}
