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

import { PrismaPg } from "@prisma/adapter-pg";

import { catalogDb } from "../lib/server/db";
import { CONTROL_PLANE_MODELS, scopedDb, TENANT_MODELS } from "../lib/server/db/scoped";
import { PrismaClient } from "../lib/generated/prisma/client";

const A = "ws_test_a";
const B = "ws_test_b";
const LINK_A = "link_test_a";
const LINK_B = "link_test_b";
const CONN = "conn_test_isolation";

const dbA = scopedDb(A);

/**
 * A second client that connects as `money_app` — the non-owner runtime role RLS
 * actually applies to — rather than through the app's extension. It exists to
 * prove the phase-6 backstop *at the database*: the same `set_config` the scoped
 * client issues, but the reads here are raw SQL, so they bypass the app-layer
 * `where` injection entirely. If a row still doesn't come back, it is Postgres
 * refusing it, not `scoped.ts`.
 *
 * Built from `DATABASE_URL` (the owner) by swapping in money_app's credentials —
 * the same shape compose uses. `next dev` connects as the owner (which bypasses
 * RLS), so without this the test could only ever exercise the app-layer filter.
 */
const rlsAppUrl = (() => {
  const url = process.env.DATABASE_URL;
  const password = process.env.APP_DB_PASSWORD;
  if (!url || !password) {
    throw new Error(
      "The RLS tests need DATABASE_URL and APP_DB_PASSWORD. Run `pnpm db:setup` " +
        "first (it creates money_app and sets its password from APP_DB_PASSWORD).",
    );
  }
  return url.replace(/\/\/[^@]+@/, `//money_app:${encodeURIComponent(password)}@`);
})();
const rlsApp = new PrismaClient({ adapter: new PrismaPg({ connectionString: rlsAppUrl }) });

/** Read tenant rows as money_app with the workspace variable set to `ws` (or, when
 *  omitted, left unset) — a raw query, so only RLS decides what returns. */
async function asWorkspace<T>(ws: string | null, sql: string, ...params: unknown[]): Promise<T[]> {
  return rlsApp.$transaction(async (tx) => {
    if (ws !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.workspace_id', $1, true)`, ws);
    return tx.$queryRawUnsafe<T[]>(sql, ...params);
  });
}

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
  await rlsApp.$disconnect();
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
        // `--untracked` is load-bearing, and its absence was a real hole: `git
        // grep` searches *tracked* files, so a brand-new file importing the raw
        // client passed this test until the moment it was committed — i.e. it
        // was silent exactly while the mistake was being made, which is the only
        // time it could have helped.
        ["grep", "-l", "--untracked", "-E", 'from "[^"]*db/client"', "--", "*.ts", "*.tsx"],
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

  // `authDb` is the unscoped client under a second name, added in phase 3 so
  // Better Auth's adapter can reach the control plane (`Membership`/`Invite`
  // span workspaces by definition — see CONTROL_PLANE_MODELS). That makes it the
  // obvious next back door: "just use authDb" would be a one-line way around
  // every guarantee above, and it would look reasonable in review.
  //
  // So it is fenced by inventory rather than by hope. Adding a file here is
  // allowed — it just has to be a decision someone typed out, with a reason.
  test("authDb is reached only from the auth layer and the bootstrap script", () => {
    const root = new URL("..", import.meta.url).pathname;

    let matches = "";
    try {
      matches = execFileSync(
        "git",
        // `-w` rather than `\bauthDb\b`: git grep's regex engine does not
        // implement `\b`, and quietly matches nothing when given it — so the
        // first draft of this test passed against a planted violation. A test
        // that cannot fail is worse than no test, because it reads like a
        // guarantee. `--untracked` for the same reason as above.
        ["grep", "-l", "-w", "--untracked", "authDb", "--", "*.ts", "*.tsx"],
        { cwd: root, encoding: "utf8" },
      );
    } catch (error) {
      const { status, stdout } = error as { status?: number; stdout?: string };
      if (status !== 1) throw error;
      matches = stdout ?? "";
    }

    const allowed = new Set([
      // Where it is defined and documented.
      "lib/server/db/index.ts",
      // The auth layer: Better Auth's adapter, and the two reads whose tenancy
      // is "the user's", not "the workspace's" — resolving a membership, and
      // listing the workspaces someone may switch to.
      "lib/server/auth/index.ts",
      "lib/server/auth/session.ts",
      "lib/server/auth/workspaces.ts",
      // Phase 4. `Membership` and `Invite` are the control plane — they decide
      // tenancy rather than being scoped by it, which is why scopedDb exempts
      // them and why there is no scoped client that could read them. Both files
      // filter by a `workspaceId` that `requireWorkspace()` already proved.
      "lib/server/auth/members.ts",
      // The invite pages, where the caller is not in a workspace and may not
      // have an account: `scopedDb` needs a workspace id to exist at all, and
      // the whole question here is which workspace — if any — this person is
      // being let into. Both read `Invite` by its own id and nothing else.
      "app/invite/[id]/page.tsx",
      "app/invite/[id]/actions.ts",
      // The bootstrap: creates the first user, who by definition has no session
      // and no membership yet.
      "scripts/create-user.ts",
      // This file.
      "tests/isolation.test.ts",
    ]);

    const offenders = matches.split("\n").filter((f) => f && !allowed.has(f));

    assert.deepEqual(
      offenders,
      [],
      `these files use authDb, the unscoped client: ${offenders.join(", ")}. ` +
        `Financial data goes through getDb() in a request or scopedDb(id) outside one. ` +
        `If this really is control-plane code, add it to the list above with a reason.`,
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

describe("Row-Level Security enforces isolation at the database, not just the app", () => {
  // These run as money_app (a non-owner role RLS applies to) and read with raw
  // SQL, so the app-layer `where` injection is out of the picture entirely. What
  // they prove is the backstop: even a query the scoped client never wrote — a
  // bug, an injection, a future unscoped path — cannot cross the workspace line.

  test("with no workspace variable set, a tenant table returns nothing (fail closed)", async () => {
    // The whole database of transactions, asked for with no scope. The app owner
    // would get everything; money_app gets zero, because the policy compares
    // against a NULL current_setting and nothing equals NULL. This is the state a
    // session-handling bug would land in, and it leaks nothing rather than all.
    const rows = await asWorkspace<{ count: bigint }>(null, `SELECT count(*)::int AS count FROM "Transaction"`);
    assert.equal(Number(rows[0].count), 0);
  });

  test("scoped to A, a raw read sees only A — even bypassing the app filter", async () => {
    const rows = await asWorkspace<{ id: string }>(A, `SELECT id FROM "Transaction"`);
    assert.deepEqual(rows.map((r) => r.id), ["trans_a"]);
  });

  test("scoped to A, B's transaction id is invisible at the database", async () => {
    // The IDOR case again, but proven one layer down: not "the scoped client
    // filtered it" — the database refused to return the row to this role at all.
    const rows = await asWorkspace<{ id: string }>(A, `SELECT id FROM "Transaction" WHERE id = $1`, "trans_b");
    assert.deepEqual(rows, []);
  });

  test("scoped to A, an INSERT of a row owned by B is rejected by WITH CHECK", async () => {
    // The write-side of the policy: money_app cannot plant a row in another
    // workspace even with a hand-written INSERT that names B directly.
    await assert.rejects(
      () =>
        asWorkspace(
          A,
          `INSERT INTO "TransferGroup" (id, "workspaceId") VALUES ($1, $2)`,
          "tg_rls_attack",
          B,
        ),
      /row-level security|violates|check/i,
    );
    const planted = await catalogDb.transferGroup.findMany({ where: { id: "tg_rls_attack" } });
    assert.equal(planted.length, 0);
  });

  test("Merchant's shared half stays visible, its private half stays scoped", async () => {
    // The one mixed table: scoped to A, RLS must still surface the global catalog
    // (workspaceId IS NULL) while hiding B's private merchant.
    const rows = await asWorkspace<{ id: string }>(A, `SELECT id FROM "Merchant"`);
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes("merchant_test_global"), "the shared catalog is not reaching money_app");
    assert.ok(ids.includes("user_a"), "workspace A's own merchant is hidden from it");
    assert.ok(!ids.includes("user_b"), "workspace B's private merchant leaked to A");
  });

  test("the owner still bypasses RLS — which is what keeps migrations and seeding working", async () => {
    // Not a hole: RLS is deliberately unforced. The owner (catalogDb here) must
    // keep seeing across workspaces, or this very test could not have seeded B,
    // and `prisma migrate deploy` could not run. The isolation that matters is
    // the app and cron connecting as the non-owner roles above.
    const all = await catalogDb.transaction.findMany({ where: { id: { in: ["trans_a", "trans_b"] } } });
    assert.equal(all.length, 2);
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
