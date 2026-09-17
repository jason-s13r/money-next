/**
 * The Akahu payload archive.
 *
 *   pnpm test
 *
 * `AkahuRecord` exists because the tables beside it are a *projection* of
 * Akahu's model, and a projection is only as good as what was known when it was
 * written. `_migrated` — the field that names an account's predecessor across an
 * open-banking migration — was in every payload ever fetched and in none of our
 * columns, so recovering it cost a two-year re-sync.
 *
 * Two properties make it worth its storage, and both are asserted here: it keeps
 * whatever Akahu sent whether or not a column mirrors it, and it does not grow
 * when nothing changes.
 *
 * Seeds its own `ws_test_archive` workspace and drops it afterwards.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { catalogDb } from "../lib/server/db";
import { scopedDb, scopedBatch } from "../lib/server/db/scoped";
import { archiveOps } from "../lib/server/ingest/archive";

const WS = "ws_test_archive";
const LINK = "link_test_archive";
const CONN = "conn_test_archive";
const ACC = "acc_test_archive";

const db = scopedDb(WS);

/** A payload shaped like Akahu's, including a field no column mirrors. */
const payload = (over: Record<string, unknown> = {}) => ({
  _id: "trans_test_archive",
  _account: ACC,
  _connection: CONN,
  description: "NEW WORLD",
  amount: -40,
  // The whole point: a key the projection knows nothing about.
  _some_future_field: "kept anyway",
  ...over,
});

async function drop() {
  await catalogDb.workspace.deleteMany({ where: { id: WS } });
  await catalogDb.connection.deleteMany({ where: { id: CONN } });
}

before(async () => {
  await drop();
  await catalogDb.connection.create({
    data: { id: CONN, name: "Test Bank", connectionType: "official" },
  });
  await catalogDb.workspace.create({
    data: { id: WS, name: "Archive test", slug: WS.replace(/_/g, "-") },
  });
  await catalogDb.bankLink.create({ data: { id: LINK, workspaceId: WS, name: "Test link" } });
  await catalogDb.account.create({
    data: {
      id: ACC, workspaceId: WS, bankLinkId: LINK, connectionId: CONN,
      name: "Everyday", status: "ACTIVE", type: "CHECKING",
    },
  });
  await catalogDb.transaction.create({
    data: {
      id: "trans_test_archive", workspaceId: WS, accountId: ACC, connectionId: CONN,
      date: new Date("2025-03-01T00:00:00Z"), description: "NEW WORLD", amount: -40, type: "DEBIT",
    },
  });
});

after(drop);

describe("archiveOps", () => {
  test("keeps a field no column mirrors — the reason the table exists", async () => {
    await scopedBatch(db, archiveOps(db, "transaction", [{ id: "trans_test_archive", payload: payload() }], null));

    const row = await db.akahuRecord.findFirst({
      where: { entityType: "transaction", entityId: "trans_test_archive" },
    });
    const kept = row?.payload as Record<string, unknown>;
    assert.equal(kept._some_future_field, "kept anyway");

    // And it is reachable as SQL, which is what turns "we need that field now"
    // into a backfill rather than another full re-fetch from Akahu.
    const [found] = await db.$queryRaw<{ value: string }[]>`
      SELECT payload->>'_some_future_field' AS value
      FROM "AkahuRecord" WHERE "entityId" = 'trans_test_archive'`;
    assert.equal(found.value, "kept anyway");
  });

  test("re-archiving the same entity overwrites rather than appends", async () => {
    await scopedBatch(db, archiveOps(db, "transaction", [{ id: "trans_test_archive", payload: payload() }], null));
    await scopedBatch(db, archiveOps(db, "transaction", [{ id: "trans_test_archive", payload: payload() }], null));

    // A sync re-fetches thousands of unchanged rows every run. One row per
    // entity is what keeps that from becoming thousands of rows a day.
    const count = await db.akahuRecord.count({ where: { entityId: "trans_test_archive" } });
    assert.equal(count, 1);
  });

  test("a changed payload replaces the old one in place", async () => {
    await scopedBatch(db, archiveOps(db, "transaction",
      [{ id: "trans_test_archive", payload: payload({ description: "PAK N SAVE" }) }], null));

    const rows = await db.akahuRecord.findMany({ where: { entityId: "trans_test_archive" } });
    assert.equal(rows.length, 1);
    assert.equal((rows[0].payload as Record<string, unknown>).description, "PAK N SAVE");
  });

  test("outlives the transaction it describes", async () => {
    // `entityId` is a plain column, not a relation, exactly so a cascade cannot
    // take the archive with the row — which is what makes it worth anything
    // after a supersession merge has deleted thousands of duplicates.
    await db.transaction.delete({ where: { id: "trans_test_archive" } });

    const row = await db.akahuRecord.findFirst({ where: { entityId: "trans_test_archive" } });
    assert.ok(row, "the payload must survive its transaction being deleted");
  });
});
