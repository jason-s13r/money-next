import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  claim,
  finalise,
  nextState,
  reapStale,
  type QueuedRun,
  type RunTable,
} from "../lib/server/run-queue";

/**
 * The queue protocol the worker runs on.
 *
 * This is the half of the queue `tests/queue.test.ts` does not reach: that one
 * covers enqueuing against a real database, and everything here happens *after* a
 * row is waiting. It is worth its own tests because it is concurrency code whose
 * failures are invisible from inside a single process — two workers both running
 * one sync looks, from either of their logs, exactly like one worker running it —
 * and because until recently it existed in triplicate, which is how one of the
 * three came to differ from the others.
 *
 * The table is a fake rather than a database. That is the point of `RunTable`
 * being a five-line interface: every rule below is about *which* statement is
 * issued and what the guard on it says, and a real Postgres would only make that
 * harder to see. `count` is the whole vocabulary — it is how the protocol learns
 * whether it won a race — so the fake's job is to answer it honestly.
 */

type Row = QueuedRun & {
  status: string;
  startedAt: Date;
  nextAttemptAt?: Date | null;
  finishedAt?: Date | null;
  error?: string | null;
};

/**
 * A `RunTable` over an array, matching the handful of `where` shapes the protocol
 * actually issues. Deliberately literal: it understands `id`, `status`, and
 * `startedAt: { lt }`, and nothing else, so a query the protocol did not write
 * before will not silently match here either.
 */
function fakeTable(rows: Row[]) {
  const calls: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];

  const matches = (row: Row, where: Record<string, unknown>) => {
    if ("id" in where && row.id !== where.id) return false;
    if ("status" in where && row.status !== where.status) return false;
    const startedAt = where.startedAt as { lt?: Date } | undefined;
    if (startedAt?.lt && !(row.startedAt < startedAt.lt)) return false;
    return true;
  };

  const table: RunTable = {
    async findMany({ where }) {
      return rows.filter((row) => matches(row, where)).map(({ id, attempts }) => ({ id, attempts }));
    },
    async updateMany({ where, data }) {
      calls.push({ where, data });
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) {
        for (const [key, value] of Object.entries(data)) {
          if (key === "attempts" && typeof value === "object" && value !== null) {
            row.attempts += (value as { increment: number }).increment;
          } else {
            Object.assign(row, { [key]: value });
          }
        }
      }
      return { count: hit.length };
    },
  };

  return { table, rows, calls };
}

const queued = (over: Partial<Row> = {}): Row => ({
  id: 1,
  attempts: 0,
  status: "queued",
  startedAt: new Date("2026-07-01T00:00:00Z"),
  nextAttemptAt: null,
  ...over,
});

describe("claim", () => {
  test("takes a queued row and marks it running", async () => {
    const { table, rows } = fakeTable([queued()]);
    assert.equal(await claim(table, 1, {}), true);
    assert.equal(rows[0].status, "running");
  });

  test("bumps attempts, so the retry cap counts tries rather than failures", async () => {
    const { table, rows } = fakeTable([queued({ attempts: 1 })]);
    await claim(table, 1, {});
    assert.equal(rows[0].attempts, 2);
  });

  test("renews the lease: startedAt becomes now, which is what staleness is measured from", async () => {
    const before = new Date("2026-07-01T00:00:00Z");
    const { table, rows } = fakeTable([queued({ startedAt: before })]);
    await claim(table, 1, {});
    assert.ok(rows[0].startedAt > before, "startedAt was not reset on claim");
  });

  test("only one of two workers wins the same row", async () => {
    // The rule the whole design rests on. The second claim's guard no longer
    // matches — the row is `running` — so its `count` is 0 and it is told to look
    // elsewhere. A read-then-write would have let both proceed.
    const { table, rows } = fakeTable([queued()]);
    assert.equal(await claim(table, 1, {}), true);
    assert.equal(await claim(table, 1, {}), false);
    assert.equal(rows[0].attempts, 1, "the loser must not have bumped attempts");
  });

  test("the guard is part of the write, not a check before it", async () => {
    const { table, calls } = fakeTable([queued()]);
    await claim(table, 1, { OR: [{ nextAttemptAt: null }] });
    assert.equal(calls.length, 1, "claiming must be exactly one statement");
    assert.equal(calls[0].where.status, "queued");
    assert.deepEqual(calls[0].where.OR, [{ nextAttemptAt: null }], "eligibility is re-asserted in the write");
  });

  test("a row that is not queued cannot be claimed", async () => {
    const { table } = fakeTable([queued({ status: "success" })]);
    assert.equal(await claim(table, 1, {}), false);
  });
});

describe("nextState", () => {
  test("below the cap, re-queues with a backoff and keeps the error", async () => {
    const { data, retryMs } = nextState(1, "Akahu timed out");
    assert.equal(data.status, "queued");
    assert.equal(data.error, "Akahu timed out");
    assert.equal(data.finishedAt, null, "a run being retried is not finished");
    assert.ok((retryMs ?? 0) > 0);
  });

  test("the backoff doubles with each attempt", () => {
    const first = nextState(1, "e").retryMs ?? 0;
    const second = nextState(2, "e").retryMs ?? 0;
    assert.equal(second, first * 2);
  });

  test("at the cap it fails for good, with no retry to report", () => {
    const { data, retryMs } = nextState(3, "still broken");
    assert.equal(data.status, "failed");
    assert.equal(retryMs, null);
    assert.ok(data.finishedAt instanceof Date, "a failed run is finished");
  });
});

describe("finalise", () => {
  test("writes the retry state onto the row", async () => {
    const { table, rows } = fakeTable([queued({ status: "running", attempts: 1 })]);
    await finalise(table, "sync run", { id: 1, attempts: 1 }, "boom");
    assert.equal(rows[0].status, "queued");
    assert.equal(rows[0].error, "boom");
    assert.ok(rows[0].nextAttemptAt instanceof Date);
  });

  test("a row deleted mid-flight is a no-op, not a crash", async () => {
    // The divergence this function exists to settle. A user can Clear a budget
    // inference while it is running, which deletes the row; `update` would throw
    // on the missing row and take down the worker tick — and with it every other
    // queue's work. Two of the three copies of this used `update`.
    const { table } = fakeTable([]);
    await assert.doesNotReject(() => finalise(table, "budget inference", { id: "gone", attempts: 1 }, "boom"));
  });
});

describe("reapStale", () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

  test("reclaims a running row whose worker died", async () => {
    const { table, rows } = fakeTable([queued({ status: "running", startedAt: ago(60), attempts: 1 })]);
    await reapStale(table, "sync run", "sync");
    // Back to queued via the retry path, with an error saying what happened.
    assert.equal(rows[0].status, "queued");
    assert.match(rows[0].error ?? "", /stopped before it finished/);
  });

  test("leaves a running row that is still inside its lease", async () => {
    const { table, rows } = fakeTable([queued({ status: "running", startedAt: ago(1) })]);
    await reapStale(table, "budget inference", "budget inference");
    assert.equal(rows[0].status, "running", "a slow but living run must not be reaped");
  });

  test("a run that finished between the read and the reclaim is left alone", async () => {
    // The race the guarded `updateMany` exists for: the reaper reads the row as
    // stale, the worker finishes it a moment later, and the reclaim must then
    // match nothing rather than drag a successful run back into the queue.
    const rows: Row[] = [queued({ status: "running", startedAt: ago(60) })];
    const { table } = fakeTable(rows);
    const raced: RunTable = {
      findMany: table.findMany,
      updateMany: async (args) => {
        rows[0].status = "success"; // the worker gets there first
        return table.updateMany(args);
      },
    };

    await reapStale(raced, "sync run", "sync");
    assert.equal(rows[0].status, "success");
    assert.equal(rows[0].error, undefined, "a finished run must not be given a failure message");
  });

  test("reclaiming counts as an attempt against the cap, so it cannot loop forever", async () => {
    // At the cap the reclaim fails the run for good rather than re-queueing it —
    // otherwise a job that reliably kills its worker would be reaped and retried
    // for as long as the worker keeps restarting.
    const { table, rows } = fakeTable([
      queued({ status: "running", startedAt: ago(60), attempts: 3 }),
    ]);
    await reapStale(table, "sync run", "sync");
    assert.equal(rows[0].status, "failed");
  });

  test("nothing stale is nothing written", async () => {
    const { table, calls } = fakeTable([queued()]);
    await reapStale(table, "rule run", "rules run");
    assert.equal(calls.length, 0);
  });
});
