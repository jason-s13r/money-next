import "server-only";
import { connection } from "next/server";
import { cache } from "react";

import { requireWorkspace } from "../auth/session";
import { getDb } from "../db/request";
import { convert, FALLBACK_DISPLAY_CURRENCY as DISPLAY_CURRENCY, loadRates } from "../currency";
import { money } from "../money";
import {
  ALWAYS,
  activeOn,
  currentOrNextWindow,
  occurrencesIn,
  type Frequency,
  type Lifespan,
} from "../../budget/recurrence";

// Reads for the budget pages: the index, one budget's plan, and the category
// group catalog the item editor picks from.
//
// Like the rest of the read layer these touch only the database and await
// `connection()` first — a budget page never computes anything it did not read.

/** A budget item, with its money already off `Decimal` and its names resolved. */
export type BudgetItemView = {
  id: string;
  name: string;
  /** Signed, like `Transaction.amount`: negative is money out. */
  amount: number;
  currency: string;
  frequency: Frequency;
  interval: number;
  anchorDate: Date;
  inferred: boolean;
  /** How a seeded row was produced — `ai` | `computed` — or null when hand-typed. */
  inferredSource: string | null;
  /** The seeder's one-line rationale, for the badge popover. Null when hand-typed. */
  basis: string | null;
  groupId: string;
  groupName: string;
  categoryId: string | null;
  categoryName: string | null;
  merchantId: string | null;
  merchantName: string | null;
};

/** A base or layer this budget relates to, for the detail page's links. */
export type BudgetRelative = { id: string; name: string };

export type BudgetView = {
  id: string;
  name: string;
  startsOn: Date | null;
  endsOn: Date | null;
  repeatsAnnually: boolean;
  origin: string;
  /** Whether this base budget is projected forward on the dashboard. */
  forecast: boolean;
  /** Null when this budget is itself a base; set to the base it layers onto. */
  baseBudgetId: string | null;
  /** The base's name, when this is a layer, for the "Layer of …" line. */
  base: BudgetRelative | null;
  /** This base's layers, when it is one; empty for a layer. */
  layers: BudgetRelative[];
  items: BudgetItemView[];
};

/** The lifespan columns, in the shape `lib/budget/recurrence.ts` speaks. */
export function lifespanOf(budget: {
  startsOn: Date | null;
  endsOn: Date | null;
  repeatsAnnually: boolean;
}): Lifespan {
  return {
    startsOn: budget.startsOn,
    endsOn: budget.endsOn,
    repeatsAnnually: budget.repeatsAnnually,
  };
}

const itemSelect = {
  id: true,
  name: true,
  amount: true,
  currency: true,
  frequency: true,
  interval: true,
  anchorDate: true,
  inferred: true,
  inferredSource: true,
  basis: true,
  categoryGroupId: true,
  categoryGroup: { select: { name: true } },
  categoryId: true,
  category: { select: { name: true } },
  merchantId: true,
  merchant: { select: { name: true } },
} as const;

type RawItem = {
  id: string;
  name: string;
  amount: import("../../generated/prisma/client").Prisma.Decimal;
  currency: string;
  frequency: string;
  interval: number;
  anchorDate: Date;
  inferred: boolean;
  inferredSource: string | null;
  basis: string | null;
  categoryGroupId: string;
  categoryGroup: { name: string };
  categoryId: string | null;
  category: { name: string } | null;
  merchantId: string | null;
  merchant: { name: string } | null;
};

/** Flatten a row to the view shape, leaving `Decimal` at the query boundary. */
function toItemView(row: RawItem): BudgetItemView {
  return {
    id: row.id,
    name: row.name,
    amount: money(row.amount),
    currency: row.currency,
    frequency: row.frequency as Frequency,
    interval: row.interval,
    anchorDate: row.anchorDate,
    inferred: row.inferred,
    inferredSource: row.inferredSource,
    basis: row.basis,
    groupId: row.categoryGroupId,
    groupName: row.categoryGroup.name,
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    merchantId: row.merchantId,
    merchantName: row.merchant?.name ?? null,
  };
}

/**
 * How much a budget commits to in a typical month, split in and out.
 *
 * Computed by expanding a whole year and dividing, rather than by scaling each
 * item's amount by a per-frequency factor. The factors would be wrong wherever a
 * cadence does not divide the year evenly — a fortnightly wage is 26 payments,
 * not 24 — and wrong again for a bounded budget, where the answer depends on how
 * much of the year the window actually covers.
 */
function monthlyTotals(items: BudgetItemView[], lifespan: Lifespan, now: Date) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(from.getUTCFullYear() + 1, from.getUTCMonth(), 1));

  let income = 0;
  let spend = 0;
  for (const item of items) {
    const count = occurrencesIn(
      { frequency: item.frequency, interval: item.interval, anchorDate: item.anchorDate },
      lifespan,
      from,
      to,
    ).length;
    const total = count * item.amount;
    if (total > 0) income += total;
    else spend += -total;
  }

  return { income: income / 12, spend: spend / 12 };
}

export type BudgetSummary = {
  id: string;
  name: string;
  origin: string;
  /** Null when this budget is a base; set to the base it layers onto, so the index
   *  can nest a layer under its base. */
  baseBudgetId: string | null;
  startsOn: Date | null;
  endsOn: Date | null;
  repeatsAnnually: boolean;
  /** Whether this base budget is projected forward on the dashboard. */
  forecast: boolean;
  items: number;
  /** Average per month over the coming year, in the display currency. */
  monthlyIn: number;
  monthlyOut: number;
  /** Whether the budget applies today — the index's first question. */
  activeNow: boolean;
};

/**
 * Every budget in the workspace, with its size and whether it is live today.
 *
 * Amounts are folded per item currency: each converts at its own rate before
 * being added, the same fold the merchants and labels indexes use, because a raw
 * sum across NZD and AUD would be a number of nothing.
 */
export const getBudgets = cache(async (asOf?: Date): Promise<BudgetSummary[]> => {
  await connection();
  // TODO: Cache Components adoption. Defaulted after connection() rather than in the
  // parameter list, which would evaluate before it: remove the connection() to
  // re-trigger the error and review the fix options.
  const now = asOf ?? new Date();
  const db = await getDb();

  const rows = await db.budget.findMany({
    orderBy: [{ startsOn: { sort: "asc", nulls: "first" } }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      origin: true,
      baseBudgetId: true,
      startsOn: true,
      endsOn: true,
      repeatsAnnually: true,
      forecast: true,
      items: { select: itemSelect },
    },
  });

  const currencies = new Set<string>([DISPLAY_CURRENCY]);
  for (const budget of rows) for (const item of budget.items) currencies.add(item.currency);
  const rates = await loadRates([...currencies]);

  return rows.map((budget) => {
    const items = budget.items.map(toItemView).map((item) => ({
      ...item,
      amount: convert(item.amount, item.currency, DISPLAY_CURRENCY, rates) ?? item.amount,
    }));
    const lifespan = lifespanOf(budget);
    const { income, spend } = monthlyTotals(items, lifespan, now);

    return {
      id: budget.id,
      name: budget.name,
      origin: budget.origin,
      baseBudgetId: budget.baseBudgetId,
      startsOn: budget.startsOn,
      endsOn: budget.endsOn,
      repeatsAnnually: budget.repeatsAnnually,
      forecast: budget.forecast,
      items: budget.items.length,
      monthlyIn: income,
      monthlyOut: spend,
      activeNow: activeOn(lifespan, now),
    };
  });
});

/** One budget by its id, with every item. Null when the id names none — including
 *  when it names another workspace's, which the scoped client makes the same thing. */
export const getBudget = cache(async (id: string): Promise<BudgetView | null> => {
  await connection();
  const db = await getDb();

  const budget = await db.budget.findFirst({
    where: { id },
    select: {
      id: true,
      name: true,
      startsOn: true,
      endsOn: true,
      repeatsAnnually: true,
      origin: true,
      forecast: true,
      baseBudgetId: true,
      // The base this layers onto (for a layer), and this base's own layers (for a
      // base) — the links the detail page draws between the two.
      base: { select: { id: true, name: true } },
      layers: {
        orderBy: [{ startsOn: { sort: "asc", nulls: "first" } }, { name: "asc" }],
        select: { id: true, name: true },
      },
      items: {
        orderBy: [{ categoryGroup: { name: "asc" } }, { name: "asc" }],
        select: itemSelect,
      },
    },
  });
  if (!budget) return null;

  return { ...budget, items: budget.items.map(toItemView) };
});

/**
 * The category groups a budget item can be filed under, for the editor's
 * required picker. The whole catalog — spending groups *and* the invented income
 * ones — because a budget has income items and they need a bucket too.
 */
export const getCategoryGroups = cache(async () => {
  await connection();
  const db = await getDb();
  return db.categoryGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
});

/** One in-flight or recently failed budget inference, for the "being created" list.
 *  Successful runs are omitted — their budget is the result and already in the list. */
export type InferenceRunView = {
  id: string;
  status: "queued" | "running" | "failed";
  /** Milliseconds, so the client can say "started 2 minutes ago". */
  startedAt: number;
  error: string | null;
  /** The budget being refreshed, for a re-infer; null for a create still in flight. */
  budgetName: string | null;
  budgetId: string | null;
  /** The conversation the run is writing its log into, when it is *this* person's to
   *  read. Null for a run someone else asked for, and for one old enough to predate
   *  the log — the run row is shared with the household, the log is not. */
  logThreadId: string | null;
};

/**
 * Queued, running and failed budget inferences for this workspace, newest first.
 *
 * The budgets page shows these so a slow background inference is visible rather than
 * silent. The worker finishes them in another process and cannot revalidate this
 * page, so the list is paired with `<AutoRefresh>` while any are still in flight.
 */
export const getBudgetInferenceRuns = cache(async (): Promise<InferenceRunView[]> => {
  await connection();
  const { user } = await requireWorkspace();
  const db = await getDb();
  const rows = await db.budgetInferenceRun.findMany({
    where: { status: { in: ["queued", "running", "failed"] } },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      status: true,
      startedAt: true,
      error: true,
      userId: true,
      threadId: true,
      budget: { select: { id: true, name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status as InferenceRunView["status"],
    startedAt: r.startedAt.getTime(),
    error: r.error,
    budgetName: r.budget?.name ?? null,
    budgetId: r.budget?.id ?? null,
    // The same rule the thread itself is under: a chat belongs to the person who
    // caused it, and the rest of the household sees the run without the link. Handing
    // out the id would only produce a 404 from `getChatThread` anyway — this is so the
    // page does not offer a link that cannot work.
    logThreadId: r.userId === user.id ? r.threadId : null,
  }));
});

/**
 * A budget's total over one instance of its own window.
 *
 * "$1,240 over 25 days" is the figure that means something for Christmas; a
 * monthly rate for a budget alive three weeks a year is an average over months it
 * does not exist in. Null for an open-ended budget, where the monthly rate *is*
 * the right summary and a lifetime total is unbounded.
 */
export function windowTotal(
  items: BudgetItemView[],
  lifespan: Lifespan,
  now: Date = new Date(),
): { income: number; spend: number; days: number } | null {
  const window = currentOrNextWindow(lifespan, now);
  if (!window) return null;

  // The range is the window, so occurrences are generated against `ALWAYS`:
  // clipping to the lifespan as well would be a second copy of the same test,
  // and two copies of a rule are two chances for it to drift.
  const to = new Date(window.to.getTime() + 86_400_000);

  let income = 0;
  let spend = 0;
  for (const item of items) {
    const count = occurrencesIn(
      { frequency: item.frequency, interval: item.interval, anchorDate: item.anchorDate },
      ALWAYS,
      window.from,
      to,
    ).length;
    const total = count * item.amount;
    if (total > 0) income += total;
    else spend += -total;
  }

  return { income, spend, days: window.days };
}
