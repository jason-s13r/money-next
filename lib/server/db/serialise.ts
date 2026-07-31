import type { PrismaPg } from "@prisma/adapter-pg";

/**
 * One statement at a time on a transaction's connection.
 *
 * The problem this exists for, in order:
 *
 *   1. Every scoped query runs inside a transaction. It has to — `set_config`
 *      is transaction-local, so the RLS variable and the query it governs must
 *      share one connection (see ./scoped).
 *   2. Prisma's client-side engine loads a query's relations *concurrently*: a
 *      `findMany` with three `include`s dispatches three `SELECT ... IN (...)`
 *      calls in one `Promise.all`.
 *   3. A transaction is pinned to a single `pg` Client, so those three land on
 *      the same connection at once. `pg` queues them and, since 8.20, warns:
 *      "Calling client.query() when the client is already executing a query is
 *      deprecated and will be removed in pg@9.0."
 *
 * The queueing is what makes the warning survivable today — the statements do
 * run one after another, in call order, and results are correct. It is pg@9
 * that is the problem: the queue goes away, and with it the only thing keeping
 * an ordinary two-`include` read on a scoped client from breaking. Both halves
 * of the cause are upstream (prisma/prisma#29407, open), so this is our own
 * floor under it rather than a patch of theirs.
 *
 * What it does is put the queue where pg's used to be: a promise chain per
 * transaction, so the adapter is handed the next statement only once the last
 * one has settled. Call order is preserved and nothing else changes — the same
 * statements, on the same connection, in the same sequence. Serialising costs
 * nothing here either, because a single connection was always going to run
 * them one at a time; the concurrency was never real.
 *
 * The pool is deliberately left alone. Outside a transaction the adapter goes
 * through `pool.query`, which checks out its own client per statement, so
 * there is nothing to serialise and no reason to make unrelated requests wait
 * on each other.
 */

type Adapter = Awaited<ReturnType<PrismaPg["connect"]>>;
type Transaction = Awaited<ReturnType<Adapter["startTransaction"]>>;

/**
 * Everything that touches the transaction's connection, including `commit` and
 * `rollback`: they end with `client.release()`, which hands the connection back
 * to the pool. A release that overtook a statement still queued behind it would
 * give the next caller a connection with someone else's work in flight.
 */
const CONNECTION_METHODS: ReadonlySet<string> = new Set([
  "queryRaw",
  "executeRaw",
  "commit",
  "rollback",
  "createSavepoint",
  "rollbackToSavepoint",
  "releaseSavepoint",
]);

/**
 * Proxy rather than subclass: `PrismaPg`'s adapter and transaction classes are
 * not exported, so there is nothing to extend. Methods are bound to the target
 * — never the proxy — so a class private field can't be read through a receiver
 * it doesn't belong to.
 */
function delegate<T extends object>(target: T, prop: string | symbol) {
  const value = Reflect.get(target, prop, target);
  return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
}

function serialiseTransaction(tx: Transaction): Transaction {
  let tail: Promise<unknown> = Promise.resolve();

  return new Proxy(tx, {
    get(target, prop) {
      const value = delegate(target, prop);
      if (typeof value !== "function" || !CONNECTION_METHODS.has(prop as string)) return value;

      return (...args: unknown[]) => {
        const result = tail.then(() => (value as (...a: unknown[]) => unknown)(...args));
        // The chain itself must never reject: a rejected tail would fail every
        // statement queued behind it, turning one bad statement into all of
        // them. The caller still gets `result`, rejection and all.
        tail = result.then(
          () => {},
          () => {},
        );
        return result;
      };
    },
  });
}

function serialiseAdapter(adapter: Adapter): Adapter {
  return new Proxy(adapter, {
    get(target, prop) {
      const value = delegate(target, prop);
      if (prop !== "startTransaction" || typeof value !== "function") return value;

      return async (...args: unknown[]) =>
        serialiseTransaction((await (value as (...a: unknown[]) => Promise<Transaction>)(...args)));
    },
  });
}

/**
 * Wrap a `PrismaPg` factory so every transaction it opens runs its statements
 * one at a time. The result is still the same factory — Prisma sees the adapter
 * interface it expects and knows nothing about this.
 */
export function serialiseTransactions(factory: PrismaPg): PrismaPg {
  return new Proxy(factory, {
    get(target, prop) {
      const value = delegate(target, prop);
      if (prop !== "connect" || typeof value !== "function") return value;

      return async (...args: unknown[]) =>
        serialiseAdapter((await (value as (...a: unknown[]) => Promise<Adapter>)(...args)));
    },
  });
}
