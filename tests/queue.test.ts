/**
 * The coalescing rules, which four callers now depend on being the same.
 *
 *   pnpm test
 *
 * `lib/server/queue.ts` is reached by the /sync button, the /rules "apply now"
 * button, the scheduled `money sync`, and the ingest queuing its own follow-up
 * rules pass. What it decides — reuse the waiting run or write a new one, widen it
 * or leave it, clear the retry backoff or respect it — is invisible at every call
 * site and is exactly the kind of thing that gets "simplified" by someone reading
 * one of them. The failure modes are quiet in both directions: coalesce too eagerly
 * and a `--full` request silently becomes an incremental one; coalesce too little
 * and a cron tick with the worker down builds a backlog that stampedes on recovery.
 *
 * Seeds its own `ws_test_queue` workspace and drops it afterwards. Nothing here
 * touches the real workspaces' data.
 *
 * Every run it writes is parked in the future via `nextAttemptAt`, which is the
 * one thing that makes a queued row unclaimable. Without that, a `pnpm worker:start`
 * running in another terminal — the normal state of a dev machine — would claim
 * these rows mid-test and try to sync a bank link that doesn't exist.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { catalogDb, scopedDb } from "../lib/server/db";
import { enqueueBudgetInference, enqueueRules, enqueueSync } from "../lib/server/queue";

const WS = "ws_test_queue";
const LINK_A = "link_test_queue_a";
const LINK_B = "link_test_queue_b";
const BUDGET_A = "budget_test_queue_a";
const BUDGET_B = "budget_test_queue_b";

const db = scopedDb(WS);

/** Park a queued run out of a live worker's reach (see the file comment).
 *  Every queue's ids are cuids now, so each helper names the table it means. */
const PARKED = new Date(Date.now() + 60 * 60 * 1000);

async function parkSync(id: string) {
  await db.syncRun.update({ where: { id }, data: { nextAttemptAt: PARKED } });
}

async function parkRule(id: string) {
  await db.ruleRun.update({ where: { id }, data: { nextAttemptAt: PARKED } });
}

async function parkInference(id: string) {
  await db.budgetInferenceRun.update({ where: { id }, data: { nextAttemptAt: PARKED } });
}

before(async () => {
  await catalogDb.workspace.deleteMany({ where: { id: WS } });
  await catalogDb.workspace.create({
    data: { id: WS, name: "Test queue", slug: "test-queue" },
  });
  for (const id of [LINK_A, LINK_B]) {
    await catalogDb.bankLink.create({ data: { id, workspaceId: WS, name: id } });
  }
  // Two budgets, so a re-infer run has a real `budgetId` to point at (the FK).
  for (const id of [BUDGET_A, BUDGET_B]) {
    await catalogDb.budget.create({ data: { id, workspaceId: WS, name: id } });
  }
});

beforeEach(async () => {
  await db.syncRun.deleteMany({});
  await db.ruleRun.deleteMany({});
  await db.budgetInferenceRun.deleteMany({});
});

after(async () => {
  await catalogDb.workspace.deleteMany({ where: { id: WS } });
  await catalogDb.$disconnect();
});

describe("enqueueSync", () => {
  test("writes a queued run when there is nothing waiting", async () => {
    const first = await enqueueSync(db, { bankLinkId: LINK_A });
    await parkSync(first.id);

    assert.equal(first.existing, false);
    const row = await db.syncRun.findUnique({ where: { id: first.id } });
    assert.equal(row?.status, "queued");
    assert.equal(row?.full, false);
    assert.equal(row?.days, null);
  });

  test("reuses the run already waiting for that link", async () => {
    const first = await enqueueSync(db, { bankLinkId: LINK_A });
    await parkSync(first.id);
    const second = await enqueueSync(db, { bankLinkId: LINK_A });

    assert.deepEqual(second, { id: first.id, existing: true });
    assert.equal(await db.syncRun.count(), 1);
  });

  test("coalesces per link, not per workspace", async () => {
    // Two links in one workspace are two different Akahu connections; a run
    // waiting for one says nothing about the other.
    const a = await enqueueSync(db, { bankLinkId: LINK_A });
    await parkSync(a.id);
    const b = await enqueueSync(db, { bankLinkId: LINK_B });
    await parkSync(b.id);

    assert.equal(b.existing, false);
    assert.notEqual(a.id, b.id);
    assert.equal(await db.syncRun.count(), 2);
  });

  test("a --full request widens the incremental run already waiting", async () => {
    const first = await enqueueSync(db, { bankLinkId: LINK_A });
    await parkSync(first.id);
    await enqueueSync(db, { bankLinkId: LINK_A, full: true });

    const row = await db.syncRun.findUnique({ where: { id: first.id } });
    assert.equal(row?.full, true, "the wider request must not be lost to the coalesce");
  });

  test("a longer --days widens a waiting run; a shorter one leaves it alone", async () => {
    const first = await enqueueSync(db, { bankLinkId: LINK_A, days: 30 });
    await parkSync(first.id);

    await enqueueSync(db, { bankLinkId: LINK_A, days: 90 });
    assert.equal((await db.syncRun.findUnique({ where: { id: first.id } }))?.days, 90);

    // The wider run already covers the narrower one, so narrowing would throw
    // away history somebody asked for.
    await enqueueSync(db, { bankLinkId: LINK_A, days: 7 });
    assert.equal((await db.syncRun.findUnique({ where: { id: first.id } }))?.days, 90);
  });

  test("a person clears the retry backoff; a timer does not", async () => {
    const first = await enqueueSync(db, { bankLinkId: LINK_A });
    await parkSync(first.id);

    // A cron tick arriving mid-backoff must leave the wait in place — resetting
    // it on every tick means a backoff longer than the cron interval never
    // elapses, and the run retries forever at the cron's cadence.
    await enqueueSync(db, { bankLinkId: LINK_A });
    assert.deepEqual(
      (await db.syncRun.findUnique({ where: { id: first.id } }))?.nextAttemptAt,
      PARKED,
    );

    // A click is an explicit override of that wait.
    await enqueueSync(db, { bankLinkId: LINK_A, clearBackoff: true });
    assert.equal(
      (await db.syncRun.findUnique({ where: { id: first.id } }))?.nextAttemptAt,
      null,
    );
  });

  test("a run that is no longer queued does not absorb the next request", async () => {
    const first = await enqueueSync(db, { bankLinkId: LINK_A });
    await db.syncRun.update({ where: { id: first.id }, data: { status: "success" } });

    const second = await enqueueSync(db, { bankLinkId: LINK_A });
    await parkSync(second.id);

    assert.equal(second.existing, false, "a finished run must not swallow a fresh request");
    assert.notEqual(second.id, first.id);
  });
});

describe("enqueueRules", () => {
  test("coalesces per workspace, whatever queued it", async () => {
    // Deliberately mixed triggers: two links finishing their syncs and a person
    // clicking "apply now" all want the same pass over the same workspace.
    const first = await enqueueRules(db, { trigger: "sync" });
    await parkRule(first.id);
    const second = await enqueueRules(db, { trigger: "manual" });

    assert.deepEqual(second, { id: first.id, existing: true });
    assert.equal(await db.ruleRun.count(), 1);
  });

  test("keeps the first asker's trigger", async () => {
    const first = await enqueueRules(db, { trigger: "sync" });
    await parkRule(first.id);
    await enqueueRules(db, { trigger: "manual" });

    // Both do identical work, so rewriting the trigger would only make the log
    // lie about what set the pass going.
    assert.equal((await db.ruleRun.findUnique({ where: { id: first.id } }))?.trigger, "sync");
  });

  test("a person clears the retry backoff; the ingest does not", async () => {
    const first = await enqueueRules(db, { trigger: "manual" });
    await parkRule(first.id);

    await enqueueRules(db, { trigger: "sync" });
    assert.deepEqual(
      (await db.ruleRun.findUnique({ where: { id: first.id } }))?.nextAttemptAt,
      PARKED,
    );

    await enqueueRules(db, { trigger: "manual", clearBackoff: true });
    assert.equal(
      (await db.ruleRun.findUnique({ where: { id: first.id } }))?.nextAttemptAt,
      null,
    );
  });
});

describe("enqueueBudgetInference", () => {
  test("writes a queued create run when nothing is waiting", async () => {
    const first = await enqueueBudgetInference(db, {});
    await parkInference(first.id);

    assert.equal(first.existing, false);
    const row = await db.budgetInferenceRun.findUnique({ where: { id: first.id } });
    assert.equal(row?.status, "queued");
    assert.equal(row?.budgetId, null, "a create run points at no budget yet");
  });

  test("coalesces two creates into the one waiting run", async () => {
    const first = await enqueueBudgetInference(db, {});
    await parkInference(first.id);
    const second = await enqueueBudgetInference(db, {});

    assert.deepEqual(second, { id: first.id, existing: true });
    assert.equal(await db.budgetInferenceRun.count(), 1);
  });

  test("a create and a re-infer never coalesce with each other", async () => {
    const create = await enqueueBudgetInference(db, {});
    await parkInference(create.id);
    const reinfer = await enqueueBudgetInference(db, { budgetId: BUDGET_A });
    await parkInference(reinfer.id);

    assert.equal(reinfer.existing, false);
    assert.notEqual(create.id, reinfer.id);
    assert.equal(await db.budgetInferenceRun.count(), 2);
  });

  test("re-infers coalesce per budget: same budget reuses, another queues anew", async () => {
    const a1 = await enqueueBudgetInference(db, { budgetId: BUDGET_A });
    await parkInference(a1.id);

    const a2 = await enqueueBudgetInference(db, { budgetId: BUDGET_A });
    assert.deepEqual(a2, { id: a1.id, existing: true });

    const b = await enqueueBudgetInference(db, { budgetId: BUDGET_B });
    await parkInference(b.id);
    assert.equal(b.existing, false);
    assert.equal(await db.budgetInferenceRun.count(), 2);
  });

  test("a person clears the retry backoff; a plain re-request does not", async () => {
    const first = await enqueueBudgetInference(db, {});
    await parkInference(first.id);

    await enqueueBudgetInference(db, {});
    assert.deepEqual(
      (await db.budgetInferenceRun.findUnique({ where: { id: first.id } }))?.nextAttemptAt,
      PARKED,
    );

    await enqueueBudgetInference(db, { clearBackoff: true });
    assert.equal(
      (await db.budgetInferenceRun.findUnique({ where: { id: first.id } }))?.nextAttemptAt,
      null,
    );
  });

  test("a settled run does not absorb the next request", async () => {
    const first = await enqueueBudgetInference(db, {});
    await db.budgetInferenceRun.update({ where: { id: first.id }, data: { status: "success" } });

    const second = await enqueueBudgetInference(db, {});
    await parkInference(second.id);

    assert.equal(second.existing, false, "a finished run must not swallow a fresh request");
    assert.notEqual(second.id, first.id);
  });
});
