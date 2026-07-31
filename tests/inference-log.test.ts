/**
 * The log an unattended budget inference writes about itself.
 *
 *   pnpm test
 *
 * Nothing here is about the inference: it is about the rows the log leaves behind,
 * which is the only thing anyone ever reads it through. Three properties matter and
 * none of them are visible from a call site.
 *
 * **The stored shape is a chat's.** The whole point of logging into `ChatMessage`
 * rather than a file is that the chat's renderer already knows how to draw it — an
 * assistant row carrying `tool_calls` in the API's own shape, a `tool` row per
 * result, matched by `tool_call_id`. Get the shape subtly wrong and nothing throws;
 * the log just renders as a column of empty bubbles.
 *
 * **A log write never breaks a run.** Every method is best-effort, and the one that
 * proves it is `openInferenceLog` with nobody to own the thread: null, and the run
 * carries on logging to the console as it always did.
 *
 * **The thread says it is a log.** `unattended` is what the turn route and the thread
 * page branch on, and a log that forgot to set it is a conversation the model would
 * happily continue — with tools that no longer exist.
 *
 * **And it is the channel back to the run.** `heard` is the only way anything a person
 * types reaches a loop running in another process, and the property it has to have is
 * exactness: every message from them, once each, and never one of the run's own. The
 * failure modes are both silent and both bad — an instruction that never lands, or the
 * brief fed back to the model on a loop.
 *
 * Seeds its own `ws_test_inflog` workspace and user, and drops both afterwards.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { catalogDb, scopedDb } from "../lib/server/db";
import { openInferenceLog } from "../lib/server/budget/inference-log";

const WS = "ws_test_inflog";
const USER = "user_test_inflog";
const NOW = new Date("2026-07-25T09:30:00Z");

const db = scopedDb(WS);

/** A queued run to log against — the FK `threadId` is written back onto it. */
async function seedRun(userId: string | null): Promise<string> {
  const run = await db.budgetInferenceRun.create({
    data: {
      workspaceId: WS,
      userId,
      status: "running",
      // Parked in the future so a `pnpm worker:start` in another terminal cannot
      // claim it mid-test, the same guard tests/queue.test.ts explains at length.
      nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
    },
    select: { id: true },
  });
  return run.id;
}

/** Somebody typing into the log while the run works, as the server action does it. */
async function said(threadId: string, content: string): Promise<void> {
  const last = await db.chatMessage.findFirst({
    where: { threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  await db.chatMessage.create({
    data: { workspaceId: WS, threadId, seq: (last?.seq ?? -1) + 1, role: "user", content },
  });
}

const messages = (threadId: string) =>
  db.chatMessage.findMany({
    where: { threadId },
    orderBy: { seq: "asc" },
    select: {
      seq: true,
      role: true,
      content: true,
      toolCalls: true,
      toolCallId: true,
      toolName: true,
      elided: true,
    },
  });

before(async () => {
  await catalogDb.workspace.deleteMany({ where: { id: WS } });
  await catalogDb.user.deleteMany({ where: { id: USER } });
  await catalogDb.workspace.create({ data: { id: WS, name: "Test log", slug: "test-inflog" } });
  await catalogDb.user.create({
    data: { id: USER, name: "Test Owner", email: "owner@test.invalid" },
  });
});

beforeEach(async () => {
  await db.budgetInferenceRun.deleteMany({});
  await db.chatThread.deleteMany({});
});

after(async () => {
  await catalogDb.workspace.deleteMany({ where: { id: WS } });
  await catalogDb.user.deleteMany({ where: { id: USER } });
  await catalogDb.$disconnect();
});

describe("openInferenceLog", () => {
  test("opens a thread, marks it a log, and claims it for the run", async () => {
    const runId = await seedRun(USER);
    const log = await openInferenceLog(db, { id: runId, userId: USER, reinfer: false, now: NOW });
    assert.ok(log, "a run with an owner gets a log");

    const thread = await db.chatThread.findFirstOrThrow({
      where: { id: log.threadId },
      select: { userId: true, title: true, unattended: true, runningSince: true },
    });
    assert.equal(thread.userId, USER, "the log belongs to whoever asked for the run");
    assert.equal(thread.unattended, true);
    assert.ok(thread.runningSince, "claimed from the start, so /chat shows it working");
    assert.match(thread.title, /^Budget inference — /);
  });

  test("says which kind of run it is in the title", async () => {
    const runId = await seedRun(USER);
    const log = await openInferenceLog(db, { id: runId, userId: USER, reinfer: true, now: NOW });
    const thread = await db.chatThread.findFirstOrThrow({
      where: { id: log!.threadId },
      select: { title: true },
    });
    assert.match(thread.title, /^Budget re-inference — /);
  });

  test("records the thread on the run, so the budgets page can link mid-run", async () => {
    const runId = await seedRun(USER);
    const log = await openInferenceLog(db, { id: runId, userId: USER, reinfer: false, now: NOW });
    const run = await db.budgetInferenceRun.findFirstOrThrow({
      where: { id: runId },
      select: { threadId: true },
    });
    assert.equal(run.threadId, log!.threadId);
  });

  test("is null when no one owns the run, and writes nothing", async () => {
    const runId = await seedRun(null);
    const log = await openInferenceLog(db, { id: runId, userId: null, reinfer: false, now: NOW });
    assert.equal(log, null, "a thread with no owner would be a thread nobody may read");
    assert.equal(await db.chatThread.count({}), 0);
  });
});

describe("what a log writes", () => {
  test("stores a round the way a chat stores one", async () => {
    const runId = await seedRun(USER);
    const log = await openInferenceLog(db, { id: runId, userId: USER, reinfer: false, now: NOW });
    assert.ok(log);

    await log.note("Model: llama3.1. 18 months of history.");
    await log.asked("Build a budget from these areas.");
    await log.said("Let me look at Food first.", [
      { id: "call_1", name: "get_transactions", input: { area: "Food", page: 1 } },
    ]);
    await log.answered({ id: "call_1", name: "get_transactions" }, { rows: [{ amount: -42 }] });

    const rows = await messages(log.threadId);
    assert.deepEqual(
      rows.map((r) => r.role),
      ["system", "user", "assistant", "tool"],
      "the run's own commentary is `system`, which is the role no model is ever sent",
    );

    const assistant = rows[2]!;
    assert.equal(assistant.content, "Let me look at Food first.");
    // The API's own shape, verbatim — this is what lib/chat/messages.ts reads back.
    assert.deepEqual(assistant.toolCalls, [
      {
        id: "call_1",
        type: "function",
        function: { name: "get_transactions", arguments: '{"area":"Food","page":1}' },
      },
    ]);

    const answer = rows[3]!;
    assert.equal(answer.toolCallId, "call_1", "matched back to the call that asked");
    assert.equal(answer.toolName, "get_transactions");
    assert.deepEqual(JSON.parse(answer.content!), { rows: [{ amount: -42 }] });
  });

  test("a reply that only calls tools has no text to show", async () => {
    const runId = await seedRun(USER);
    const log = (await openInferenceLog(db, {
      id: runId,
      userId: USER,
      reinfer: false,
      now: NOW,
    }))!;

    await log.said("   ", [{ id: "call_2", name: "finish", input: {} }]);

    const rows = await messages(log.threadId);
    assert.equal(rows[0]!.content, null, "whitespace is not a thing anybody said");
  });

  test("elision marks the served rows and keeps them", async () => {
    const runId = await seedRun(USER);
    const log = (await openInferenceLog(db, {
      id: runId,
      userId: USER,
      reinfer: false,
      now: NOW,
    }))!;

    await log.answered({ id: "call_a", name: "get_transactions" }, { rows: ["page one"] });
    await log.answered({ id: "call_b", name: "get_transactions" }, { rows: ["page two"] });
    await log.elide(["call_a"]);

    const rows = await messages(log.threadId);
    const elided = rows.find((r) => r.toolCallId === "call_a")!;
    const kept = rows.find((r) => r.toolCallId === "call_b")!;
    assert.equal(elided.elided, true, "dropped from the model's view");
    assert.deepEqual(JSON.parse(elided.content!), { rows: ["page one"] }, "and kept for the person");
    assert.equal(kept.elided, false);
  });

  test("what the person watching says comes back, once, and the run's own does not", async () => {
    const runId = await seedRun(USER);
    const log = (await openInferenceLog(db, {
      id: runId,
      userId: USER,
      reinfer: false,
      now: NOW,
    }))!;

    await log.asked("Build a budget from these areas.");
    assert.deepEqual(await log.heard(), [], "the brief is the run talking to itself");

    // What the app appends when somebody types on the log's page.
    await said(log.threadId, "Leave the holiday spending out of it.");
    assert.deepEqual(await log.heard(), ["Leave the holiday spending out of it."]);
    assert.deepEqual(await log.heard(), [], "and not a second time");

    // The interleaving that a high-water seq would get wrong: they type while the run is
    // mid-round, so their row is *older* than the next thing the run writes.
    await said(log.threadId, "Groceries are fortnightly, not weekly.");
    await log.said("Right — reading Food again.", []);
    await log.asked("2 areas still have no items.");
    assert.deepEqual(
      await log.heard(),
      ["Groceries are fortnightly, not weekly."],
      "a message the run has written past is still a message to the run",
    );
  });

  test("a stop is seen only once it has been asked for", async () => {
    const runId = await seedRun(USER);
    const log = (await openInferenceLog(db, {
      id: runId,
      userId: USER,
      reinfer: false,
      now: NOW,
    }))!;

    assert.equal(await log.stopRequested(), false);
    await db.budgetInferenceRun.updateMany({
      where: { id: runId },
      data: { stopRequestedAt: new Date() },
    });
    assert.equal(await log.stopRequested(), true, "the only signal the worker gets");
  });

  test("closing releases the claim, so the thread stops saying it is working", async () => {
    const runId = await seedRun(USER);
    const log = (await openInferenceLog(db, {
      id: runId,
      userId: USER,
      reinfer: false,
      now: NOW,
    }))!;

    await log.close();

    const thread = await db.chatThread.findFirstOrThrow({
      where: { id: log.threadId },
      select: { runningSince: true },
    });
    assert.equal(thread.runningSince, null);
  });
});
