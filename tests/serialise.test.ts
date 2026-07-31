/**
 * One statement at a time on a transaction's connection.
 *
 *   pnpm test
 *
 * `lib/server/db/serialise.ts` exists because two upstream facts collide: every
 * scoped query runs in a transaction (the RLS variable has to share the query's
 * connection), and Prisma loads a query's relations concurrently. Three
 * `include`s therefore arrive at one `pg` Client at once, which works today only
 * because `pg` queues them — a queue it deprecates and removes in pg@9.
 *
 * That makes this a regression test for something with no symptom of its own:
 * remove the wrapper and every one of the 500-odd tests still passes, the app
 * still works, and the only sign is a deprecation warning in the log. So the
 * warning is what the second test asserts on, directly.
 *
 * The first test does not touch the database: it drives the wrapper with a stub
 * adapter, which is the only way to observe the ordering rather than infer it.
 *
 * Reads only, and from a workspace id that exists nowhere. Nothing is seeded and
 * nothing is written.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { PrismaPg } from "@prisma/adapter-pg";

import { catalogDb, scopedDb } from "../lib/server/db";
import { serialiseTransactions } from "../lib/server/db/serialise";

/** A stub transaction that reports how many of its statements were ever in
 *  flight together, and the order they were started in. */
function recordingTransaction() {
  const log: string[] = [];
  let live = 0;
  let peak = 0;

  const statement = async (sql: string) => {
    live++;
    peak = Math.max(peak, live);
    log.push(sql);
    // A real statement is not instantaneous, and the overlap this guards against
    // only exists across an await.
    await sleep(1);
    live--;
    if (sql === "boom") throw new Error("boom");
    return sql;
  };

  const tx = {
    queryRaw: (query: { sql: string }) => statement(query.sql),
    executeRaw: (query: { sql: string }) => statement(query.sql),
    commit: () => statement("COMMIT"),
    rollback: () => statement("ROLLBACK"),
    options: { usePhantomQuery: false },
  };

  const factory = {
    connect: async () => ({ startTransaction: async () => tx }),
  } as unknown as PrismaPg;

  return { factory, log, peak: () => peak };
}

async function openTransaction(factory: PrismaPg) {
  const adapter = await serialiseTransactions(factory).connect();
  return adapter.startTransaction();
}

describe("serialiseTransactions", () => {
  test("statements dispatched together still run one at a time, in order", async () => {
    const { factory, log, peak } = recordingTransaction();
    const tx = await openTransaction(factory);

    // The shape Prisma produces for a read with three `include`s: one
    // `Promise.all` over the relation loads.
    await Promise.all(
      ["category", "merchant", "budget"].map((sql) => tx.queryRaw({ sql } as never)),
    );

    assert.equal(peak(), 1, "two statements were in flight on one connection at once");
    assert.deepEqual(log, ["category", "merchant", "budget"], "call order was not preserved");
  });

  test("a failed statement fails only itself, and the ones behind it still run", async () => {
    const { factory, log } = recordingTransaction();
    const tx = await openTransaction(factory);

    const results = await Promise.allSettled([
      tx.queryRaw({ sql: "boom" } as never),
      tx.queryRaw({ sql: "after" } as never),
    ]);

    assert.equal(results[0].status, "rejected");
    assert.equal(results[1].status, "fulfilled");
    assert.deepEqual(log, ["boom", "after"]);
  });

  test("the commit waits for the statements, so the connection is released after them", async () => {
    const { factory, log } = recordingTransaction();
    const tx = await openTransaction(factory);

    const query = tx.queryRaw({ sql: "slow" } as never);
    const commit = tx.commit();
    await Promise.all([query, commit]);

    assert.deepEqual(log, ["slow", "COMMIT"]);
  });
});

describe("the real client", () => {
  after(async () => {
    await catalogDb.$disconnect();
  });

  test("a scoped read with several relations warns about nothing", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(`${warning.name}: ${warning.message}`);
    process.on("warning", onWarning);

    try {
      // Three relations, which is what it takes: `pg` warns once its queue has a
      // second statement waiting behind the one it is running. A workspace that
      // does not exist is deliberate — the relation loads are dispatched the
      // same way for no rows as for a thousand, and this test writes nothing.
      await scopedDb("ws_test_serialise").budgetItem.findMany({
        take: 5,
        include: { category: true, merchant: true, budget: true },
      });
      // `process.emitWarning` is delivered on the next tick.
      await sleep(10);
    } finally {
      process.off("warning", onWarning);
    }

    assert.deepEqual(warnings, [], "the driver was handed overlapping statements on one connection");
  });
});
