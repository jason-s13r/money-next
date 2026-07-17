/**
 * The test that makes the scoped client trustworthy.
 *
 *   pnpm test
 *
 * `scopedDb` is a single point of failure by design: everything above it is
 * written as if tenancy did not exist, which is only safe while this holds. So
 * this seeds two workspaces and asserts a client scoped to one cannot read,
 * count, update or delete anything belonging to the other — per model, rather
 * than per query, because the queries are the thing that keeps changing.
 *
 * It touches only its own `ws_test_*` workspaces and drops them afterwards.
 * Nothing here reads or writes the real bootstrap workspace's data.
 *
 * Uses Node's built-in test runner: no test framework in package.json, for the
 * same reason `node:sqlite` was used for the import — a dependency that exists
 * only to be deleted later is not worth the install.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import { catalogDb } from "../lib/server/db";
import { CONTROL_PLANE_MODELS, scopedDb, TENANT_MODELS } from "../lib/server/db/scoped";

const A = "ws_test_a";
const B = "ws_test_b";
const LINK_A = "link_test_a";
const LINK_B = "link_test_b";
const CONN = "conn_test_isolation";

const dbA = scopedDb(A);

/** A whole tenant's worth of rows, so every scoped model has something to leak. */
async function seed(ws: string, link: string, tag: string) {
  await catalogDb.workspace.create({
    data: { id: ws, name: `Test ${tag}`, slug: `test-${tag}` },
  });
  await catalogDb.bankLink.create({
    data: { id: link, workspaceId: ws, name: `Bank ${tag}` },
  });
  await catalogDb.account.create({
    data: {
      id: `acc_${tag}`,
      workspaceId: ws,
      bankLinkId: link,
      connectionId: CONN,
      name: `Account ${tag}`,
      status: "ACTIVE",
      type: "CHECKING",
      currency: "NZD",
      balanceCurrent: 100,
    },
  });
  await catalogDb.transaction.create({
    data: {
      id: `trans_${tag}`,
      workspaceId: ws,
      accountId: `acc_${tag}`,
      connectionId: CONN,
      date: new Date("2026-01-01T00:00:00Z"),
      description: `Transaction ${tag}`,
      amount: -10,
      type: "DEBIT",
    },
  });
  await catalogDb.pendingTransaction.create({
    data: {
      workspaceId: ws,
      accountId: `acc_${tag}`,
      connectionId: CONN,
      date: new Date("2026-01-02T00:00:00Z"),
      description: `Pending ${tag}`,
      amount: -5,
      type: "DEBIT",
      akahuUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    },
  });
  await catalogDb.balanceSnapshot.create({
    data: {
      workspaceId: ws,
      accountId: `acc_${tag}`,
      currency: "NZD",
      current: 100,
      capturedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  await catalogDb.ruleDocument.create({
    // Same slug in both workspaces: proves the per-workspace unique constraint
    // is the right one. Instance-wide, this second create would throw.
    data: { workspaceId: ws, name: "Automations", slug: "automations", content: "{}", active: true },
  });
  await catalogDb.merchant.create({
    data: { id: `user_${tag}`, workspaceId: ws, name: `Private merchant ${tag}` },
  });
  await catalogDb.fieldChange.create({
    data: {
      workspaceId: ws,
      transactionId: `trans_${tag}`,
      field: "category",
      source: "user",
      fromLabel: `Was ${tag}`,
      toLabel: `Now ${tag}`,
    },
  });
}

async function drop(ws: string) {
  await catalogDb.workspace.deleteMany({ where: { id: ws } });
}

before(async () => {
  await drop(A);
  await drop(B);
  await catalogDb.merchant.deleteMany({ where: { id: { in: [`user_a`, `user_b`, "merchant_test_global"] } } });
  await catalogDb.connection.deleteMany({ where: { id: CONN } });

  await catalogDb.connection.create({
    data: { id: CONN, name: "Test Bank", connectionType: "classic" },
  });
  // A global catalog merchant, to prove the shared half of `Merchant` still
  // reaches everyone.
  await catalogDb.merchant.create({
    data: { id: "merchant_test_global", workspaceId: null, name: "Global merchant" },
  });
  await seed(A, LINK_A, "a");
  await seed(B, LINK_B, "b");
});

after(async () => {
  await drop(A);
  await drop(B);
  await catalogDb.merchant.deleteMany({ where: { id: "merchant_test_global" } });
  await catalogDb.connection.deleteMany({ where: { id: CONN } });
  await catalogDb.$disconnect();
});

describe("scopedDb refuses to build without a scope", () => {
  test("an empty workspace id throws rather than returning an unfiltered client", () => {
    assert.throws(() => scopedDb(""), /requires a workspaceId/);
  });
});

describe("the schema and the scoped client agree", () => {
  // The test that catches the *next* model somebody adds. A new tenant-owned
  // model that nobody registers in TENANT_MODELS would be silently unscoped —
  // no error, no failing query, just every workspace reading every row.
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  /** Models declaring a `workspaceId` field, straight from the schema. */
  const declared = new Set<string>();
  for (const block of schema.split(/^model\s+/m).slice(1)) {
    const name = block.split(/\s/)[0];
    const body = block.slice(0, block.indexOf("\n}"));
    if (/^\s*workspaceId\s+String/m.test(body)) declared.add(name);
  }

  test("every model with a workspaceId is classified", () => {
    // Not "is scoped" — `CONTROL_PLANE_MODELS` is a deliberate exemption. The
    // property is that no model gets to be unscoped by *accident*.
    const classified = new Set([...TENANT_MODELS, ...CONTROL_PLANE_MODELS, "Merchant"]);
    const forgotten = [...declared].filter((m) => !classified.has(m));
    assert.deepEqual(
      forgotten,
      [],
      `these models carry a workspaceId but scopedDb neither scopes them nor ` +
        `exempts them, so every workspace can read every row of them: ` +
        `${forgotten.join(", ")}. Add them to TENANT_MODELS, or to ` +
        `CONTROL_PLANE_MODELS with a reason.`,
    );
  });

  test("the control-plane exemption stays small and deliberate", () => {
    // A tripwire, not a rule. If this list grows, the scoped client is
    // protecting less than it appears to, and that should be a conscious edit
    // rather than a drift.
    assert.deepEqual([...CONTROL_PLANE_MODELS].sort(), ["Invite", "Membership"]);
  });

  test("every model the client scopes actually has a workspaceId", () => {
    const missing = [...TENANT_MODELS].filter((m) => !declared.has(m));
    assert.deepEqual(missing, [], `scopedDb filters on a column these models lack: ${missing.join(", ")}`);
  });
});

describe("the unscoped client stays unreachable", () => {
  // There is an ESLint rule for this too (see eslint.config.mjs), and it now
  // runs — `pnpm lint` was fixed by pinning off the TypeScript 7 preview that
  // typescript-eslint crashed on. This stays regardless, and is still the real
  // control: a rule that only holds while a toolchain lines up is a rule that
  // stops holding quietly. This fails on a planted violation either way.
  //
  // Worth enforcing somewhere: every guarantee above rests on the raw client
  // being unreachable. One import of it in a query file and the scoping is
  // advisory.
  test("nothing outside lib/server/db imports the raw client", () => {
    const root = new URL("..", import.meta.url).pathname;

    // `git grep` exits 1 when it matches nothing — which here is the passing
    // case, so a non-zero exit is a result, not a failure.
    let matches = "";
    try {
      matches = execFileSync(
        "git",
        ["grep", "-l", "-E", 'from "[^"]*db/client"', "--", "*.ts", "*.tsx"],
        { cwd: root, encoding: "utf8" },
      );
    } catch (error) {
      const { status, stdout } = error as { status?: number; stdout?: string };
      if (status !== 1) throw error;
      matches = stdout ?? "";
    }

    const offenders = matches
      .split("\n")
      .filter((f) => f && !f.startsWith("lib/server/db/"));

    assert.deepEqual(
      offenders,
      [],
      `these files import the unscoped Prisma client and can read every ` +
        `workspace's data: ${offenders.join(", ")}`,
    );
  });
});

describe("a client scoped to A cannot see B", () => {
  test("findMany returns only its own rows", async () => {
    const txs = await dbA.transaction.findMany();
    assert.deepEqual(txs.map((t) => t.id), ["trans_a"]);

    const accounts = await dbA.account.findMany();
    assert.deepEqual(accounts.map((a) => a.id), ["acc_a"]);

    const pending = await dbA.pendingTransaction.findMany();
    assert.deepEqual(pending.map((p) => p.description), ["Pending a"]);

    const snapshots = await dbA.balanceSnapshot.findMany();
    assert.equal(snapshots.length, 1);

    const links = await dbA.bankLink.findMany();
    assert.deepEqual(links.map((l) => l.id), [LINK_A]);

    // The field change log holds the labels of what a transaction used to be —
    // "salary", a merchant someone banks with — so it leaks the same financial
    // detail the transaction does, and has to be scoped just as hard.
    const changes = await dbA.fieldChange.findMany();
    assert.deepEqual(changes.map((c) => c.toLabel), ["Now a"]);
  });

  test("findUnique on B's id returns null — the IDOR case", async () => {
    // The sharpest one: a guessed `trans_...` in the URL. Prisma 7 accepts the
    // injected non-unique field alongside the unique one and filters on it, so
    // this closes without rewriting the operation.
    assert.equal(await dbA.transaction.findUnique({ where: { id: "trans_b" } }), null);
    assert.equal(await dbA.account.findUnique({ where: { id: "acc_b" } }), null);
    assert.notEqual(await dbA.transaction.findUnique({ where: { id: "trans_a" } }), null);
  });

  test("a where naming B's workspace cannot override the scope", async () => {
    // The attack the AND (rather than a spread) exists to stop.
    const rows = await dbA.transaction.findMany({ where: { workspaceId: B } });
    assert.deepEqual(rows, []);
  });

  test("count and aggregate see only A", async () => {
    assert.equal(await dbA.transaction.count(), 1);
    const agg = await dbA.transaction.aggregate({ _sum: { amount: true } });
    assert.equal(agg._sum.amount?.toString(), "-10");
  });

  test("groupBy sees only A", async () => {
    const groups = await dbA.transaction.groupBy({ by: ["workspaceId"], _count: true });
    assert.deepEqual(groups.map((g) => g.workspaceId), [A]);
  });

  test("update cannot reach B's rows", async () => {
    const { count } = await dbA.transaction.updateMany({
      where: { id: "trans_b" },
      data: { description: "pwned" },
    });
    assert.equal(count, 0);
    const b = await catalogDb.transaction.findUnique({ where: { id: "trans_b" } });
    assert.equal(b?.description, "Transaction b");
  });

  test("delete cannot reach B's rows", async () => {
    const { count } = await dbA.transaction.deleteMany({ where: { id: "trans_b" } });
    assert.equal(count, 0);
    assert.notEqual(await catalogDb.transaction.findUnique({ where: { id: "trans_b" } }), null);
  });

  test("the pending full-table replace only empties its own workspace", async () => {
    // The bug a single-workspace test could never show: `deleteMany({})` in
    // syncPendingTransactions reads as "delete every pending row in the
    // database", so unscoped, A's sync would wipe B's pending rows.
    await dbA.pendingTransaction.deleteMany({});

    assert.equal(await dbA.pendingTransaction.count(), 0);
    const survivors = await catalogDb.pendingTransaction.findMany({ where: { workspaceId: B } });
    assert.equal(survivors.length, 1, "workspace B's pending rows were wiped by workspace A's sync");
  });
});

describe("writes are stamped with the scope, not the caller's claim", () => {
  test("a create is stamped with the client's workspace", async () => {
    const group = await dbA.transferGroup.create({ data: { workspaceId: A } });
    const stored = await catalogDb.transferGroup.findUnique({ where: { id: group.id } });
    assert.equal(stored?.workspaceId, A);
    await catalogDb.transferGroup.delete({ where: { id: group.id } });
  });

  test("a create naming another workspace is refused, not silently rewritten", async () => {
    await assert.rejects(
      () => dbA.transferGroup.create({ data: { workspaceId: B } }),
      /Refusing to write a row owned by workspace ws_test_b/,
    );
  });
});

describe("Merchant is shared catalog plus private rows", () => {
  test("reads see the global catalog and its own, never another workspace's", async () => {
    // Asserted as a property rather than an exact list: the real database holds
    // hundreds of global Akahu merchants, and workspace A seeing all of them is
    // the point of the shared catalog.
    const rows = await dbA.merchant.findMany();
    const ids = rows.map((m) => m.id);

    assert.ok(ids.includes("merchant_test_global"), "the shared catalog is not reaching workspace A");
    assert.ok(ids.includes("user_a"), "workspace A cannot see its own private merchant");
    assert.ok(!ids.includes("user_b"), "workspace B's private merchant leaked into workspace A");
    assert.ok(
      rows.every((m) => m.workspaceId === null || m.workspaceId === A),
      "a merchant belonging to another workspace was returned",
    );
  });

  test("a merchant create must say which kind it is", async () => {
    // Note this call typechecks: `workspaceId` is nullable on Merchant, so
    // Prisma makes it optional on create and the compiler is content to leave it
    // out. That is exactly why the guard is a runtime one — this is the single
    // model where the types cannot ask the question for us.
    await assert.rejects(
      () => dbA.merchant.create({ data: { id: "user_nope", name: "Ambiguous" } }),
      /must set workspaceId explicitly/,
    );
  });

  test("a private merchant can be created, and a global one stays global", async () => {
    const priv = await dbA.merchant.create({
      data: { id: "user_test_new", workspaceId: A, name: "Mine" },
    });
    assert.equal(priv.workspaceId, A);

    const global = await dbA.merchant.create({
      data: { id: "merchant_test_new", workspaceId: null, name: "Akahu's" },
    });
    assert.equal(global.workspaceId, null);

    await catalogDb.merchant.deleteMany({
      where: { id: { in: ["user_test_new", "merchant_test_new"] } },
    });
  });
});

describe("shared catalogs stay shared", () => {
  test("a scoped client reads the global catalogs unfiltered", async () => {
    // Categories, FX rates and connections are public facts, identical for
    // everyone. Scoping them would mean re-importing the NZFCC standard per
    // workspace.
    const conn = await dbA.connection.findUnique({ where: { id: CONN } });
    assert.notEqual(conn, null);
  });
});
