// The two work queues, from the enqueuing side.
//
// Phase 7 moved the work off the request: nothing that talks to Akahu or walks
// every transaction runs in the web process any more. Instead a caller writes a
// `queued` SyncRun or RuleRun — a tenant INSERT `money_app` already holds — and
// the `money_sync` worker claims it, runs it and finalises it.
//
// Four enqueuers must agree, which is why this module exists rather than the
// `create` being written out at each one: the /sync button, the /rules "apply
// now" button, the scheduled `money sync`, and the ingest queuing the rules pass
// that follows it.
//
// No `server-only`: the last two run in plain Node, where it throws.
//
// ## Coalescing
//
// Every enqueue here reuses a job already waiting rather than stacking another
// one. A queue of identical jobs is worse than useless — mashing "sync now"
// would spend the Akahu rate limit N times to fetch the same window, and a cron
// firing while the worker is down would accumulate a run per tick and then
// stampede when it comes back. What the caller wants is "make sure this happens
// soon", which one waiting row already satisfies.
//
// `clearBackoff` is the difference between a person and a timer. A failed run
// sitting out its exponential backoff is still `queued`, so it coalesces; when a
// *person* clicks the button that is an explicit override and the wait is
// dropped, but a scheduled sync arriving mid-backoff must not reset it, or the
// backoff would never elapse on any interval shorter than itself.

import type { ScopedDb } from "./db";

/** What happened, so a CLI can say "queued" or "already queued" honestly. */
export type Enqueued<Id> = { id: Id; existing: boolean };

/**
 * Queue a sync for one bank link, or reuse the one already waiting for it.
 *
 * Coalesced per *link*, not per workspace: two links in one workspace are two
 * different Akahu connections, and a run names the link it is for, so a queued
 * run for one says nothing about the other.
 *
 * `full`/`days` are persisted on the row (they are what the runner reproduces)
 * and are also *upgrades* when they land on a run already waiting: a `--full`
 * request arriving behind a queued incremental widens it rather than being
 * silently dropped by the coalesce. Never the reverse — an incremental request
 * cannot narrow a queued full sync, since the wider run satisfies both.
 */
export async function enqueueSync(
  db: ScopedDb,
  opts: { bankLinkId: string; full?: boolean; days?: number; clearBackoff?: boolean },
): Promise<Enqueued<number>> {
  const waiting = await db.syncRun.findFirst({
    where: { status: "queued", bankLinkId: opts.bankLinkId },
    orderBy: { startedAt: "asc" },
  });

  if (waiting) {
    const data: { full?: boolean; days?: number; nextAttemptAt?: null } = {};
    if (opts.full && !waiting.full) data.full = true;
    if (opts.days !== undefined && (waiting.days === null || opts.days > waiting.days)) {
      data.days = opts.days;
    }
    if (opts.clearBackoff && waiting.nextAttemptAt && waiting.nextAttemptAt > new Date()) {
      data.nextAttemptAt = null;
    }
    if (Object.keys(data).length > 0) {
      await db.syncRun.update({ where: { id: waiting.id }, data });
    }
    return { id: waiting.id, existing: true };
  }

  const run = await db.syncRun.create({
    data: {
      workspaceId: db.$workspaceId,
      bankLinkId: opts.bankLinkId,
      status: "queued",
      full: opts.full ?? false,
      days: opts.days,
    },
  });
  return { id: run.id, existing: false };
}

/**
 * Queue a rules pass over the workspace, or reuse the one already waiting.
 *
 * Coalesced per workspace, because unlike a sync a rules run has no narrower
 * subject: it evaluates the workspace's transactions against the one active
 * decision document. Two syncs finishing together therefore produce one rules
 * pass, which is the behaviour you want — the second would have found nothing
 * the first hadn't already handled.
 *
 * `trigger` records who asked (`sync` after an ingest, `manual` from the button)
 * and is left alone when coalescing: the first asker gets the credit, and both
 * runs do the same work either way.
 */
export async function enqueueRules(
  db: ScopedDb,
  opts: { trigger: "sync" | "manual"; clearBackoff?: boolean },
): Promise<Enqueued<string>> {
  const waiting = await db.ruleRun.findFirst({
    where: { status: "queued" },
    orderBy: { startedAt: "asc" },
  });

  if (waiting) {
    if (opts.clearBackoff && waiting.nextAttemptAt && waiting.nextAttemptAt > new Date()) {
      await db.ruleRun.update({ where: { id: waiting.id }, data: { nextAttemptAt: null } });
    }
    return { id: waiting.id, existing: true };
  }

  const run = await db.ruleRun.create({
    data: { workspaceId: db.$workspaceId, trigger: opts.trigger, status: "queued" },
  });
  return { id: run.id, existing: false };
}

/**
 * Queue a budget inference, or reuse the one already waiting for the same target.
 *
 * Inference talks to a local LLM, which is far too slow to hold a request open for
 * (see `BudgetInferenceRun`), so the web app enqueues and the worker runs it.
 *
 * Coalesced per *target*: a create (`budgetId` null) coalesces with another queued
 * create, and a re-infer coalesces with a queued re-infer of the same budget — two
 * clicks of the same button should not run the model twice over the same history.
 * A create and a re-infer never coalesce with each other, and re-inferring two
 * different budgets queues two runs.
 *
 * `userId` records who asked, and is left alone when coalescing — the first asker gets
 * the credit, exactly as `trigger` does above. It matters more here than there: the run
 * logs its whole conversation into a thread owned by that person (see
 * lib/server/budget/inference-log.ts), so this is what decides whether the log exists
 * and whose /chat it appears in. A run enqueued with no session behind it has no owner
 * and is logged to the worker's console only.
 */
export async function enqueueBudgetInference(
  db: ScopedDb,
  opts: { budgetId?: string | null; userId?: string | null; clearBackoff?: boolean } = {},
): Promise<Enqueued<string>> {
  const budgetId = opts.budgetId ?? null;

  const waiting = await db.budgetInferenceRun.findFirst({
    where: { status: "queued", budgetId },
    orderBy: { startedAt: "asc" },
  });

  if (waiting) {
    if (opts.clearBackoff && waiting.nextAttemptAt && waiting.nextAttemptAt > new Date()) {
      await db.budgetInferenceRun.update({
        where: { id: waiting.id },
        data: { nextAttemptAt: null },
      });
    }
    return { id: waiting.id, existing: true };
  }

  const run = await db.budgetInferenceRun.create({
    data: {
      workspaceId: db.$workspaceId,
      status: "queued",
      budgetId,
      userId: opts.userId ?? null,
    },
  });
  return { id: run.id, existing: false };
}
