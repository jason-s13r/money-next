/**
 * The merge that resolves a bank migration.
 *
 *   pnpm test
 *
 * When an institution moves to official open banking, Akahu mints new ids for
 * the same real accounts and transactions, so a workspace ends up holding its
 * money twice. `applySupersession` folds the old rows into the new ones. It is
 * destructive — it deletes the duplicates — so what it does has to be pinned
 * down rather than eyeballed once on real data and assumed ever after.
 *
 * The invariant everything else rests on, and the reason the merge is worth its
 * risk: **a superseded account holds nothing that exists elsewhere**. That is
 * what lets every spend, flow and budget query stay ignorant of supersession,
 * and a regression here would put silent double counting back into all of them.
 *
 * Its other half is that a row Akahu never re-issued is *not* deleted and *not*
 * moved: it stays on the old account and goes on counting. Akahu backfills over
 * days, so the pair has to stay re-runnable to catch what arrives later — the
 * cases below pin both halves down.
 *
 * Seeds its own `ws_test_supersede` workspace and drops it afterwards.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { catalogDb } from "../lib/server/db";
import { scopedDb } from "../lib/server/db/scoped";
import {
  applySupersession,
  planSupersession,
  proposeSupersessions,
} from "../lib/server/accounts/supersede";

const WS = "ws_test_supersede";
const LINK = "link_test_supersede";
const CONN_OLD = "conn_test_sup_classic";
const CONN_NEW = "conn_test_sup_official";
const OLD = "acc_test_sup_old";
const NEW = "acc_test_sup_new";
/** An account that names a predecessor this workspace never ingested — the ASB
 *  case, which `--auto` must skip rather than choke on. */
const DANGLING = "acc_test_sup_dangling";
const GROUP = "group_test_supersede";
const CAT = "cat_test_supersede";

const db = scopedDb(WS);

const day = (d: string) => new Date(`${d}T00:00:00Z`);

/** One transaction, with only the fields a merge actually reasons about. */
async function tx(args: {
  id: string;
  account: string;
  connection: string;
  date: string;
  amount: number;
  description: string;
  migratedFromId?: string;
  categoryId?: string;
  categorySource?: string;
  merchantSource?: string;
  taxYear?: number;
  transferGroupId?: string;
}) {
  await catalogDb.transaction.create({
    data: {
      id: args.id,
      workspaceId: WS,
      accountId: args.account,
      connectionId: args.connection,
      date: day(args.date),
      description: args.description,
      amount: args.amount,
      type: "DEBIT",
      migratedFromId: args.migratedFromId ?? null,
      categoryId: args.categoryId ?? null,
      categoryGroupId: args.categoryId ? GROUP : null,
      categorySource: args.categorySource ?? "akahu",
      merchantSource: args.merchantSource ?? "akahu",
      taxYear: args.taxYear ?? null,
      transferGroupId: args.transferGroupId ?? null,
    },
  });
}

async function drop() {
  await catalogDb.workspace.deleteMany({ where: { id: WS } });
  await catalogDb.category.deleteMany({ where: { id: CAT } });
  await catalogDb.categoryGroup.deleteMany({ where: { id: GROUP } });
  await catalogDb.connection.deleteMany({ where: { id: { in: [CONN_OLD, CONN_NEW] } } });
}

before(async () => {
  await drop();

  await catalogDb.connection.create({
    data: { id: CONN_OLD, name: "Test Bank", connectionType: "classic" },
  });
  await catalogDb.connection.create({
    data: { id: CONN_NEW, name: "Test Bank", connectionType: "official" },
  });
  await catalogDb.categoryGroup.create({ data: { id: GROUP, name: "Groceries" } });
  await catalogDb.category.create({
    data: { id: CAT, name: "Supermarket", direction: "debit", groupId: GROUP },
  });

  await catalogDb.workspace.create({
    data: { id: WS, name: "Supersede test", slug: WS.replace(/_/g, "-") },
  });
  await catalogDb.bankLink.create({
    data: { id: LINK, workspaceId: WS, name: "Test link" },
  });

  const account = (id: string, connectionId: string, extra = {}) => ({
    id,
    workspaceId: WS,
    bankLinkId: LINK,
    connectionId,
    name: "Everyday",
    status: "ACTIVE",
    type: "CHECKING",
    currency: "NZD",
    balanceCurrent: 100,
    ...extra,
  });

  await catalogDb.account.create({ data: account(OLD, CONN_OLD) });
  await catalogDb.account.create({
    data: account(NEW, CONN_NEW, { migratedFromId: OLD, balanceCurrent: 250 }),
  });
  await catalogDb.account.create({
    data: account(DANGLING, CONN_NEW, { migratedFromId: "acc_never_ingested" }),
  });

  await catalogDb.transferGroup.create({ data: { id: "tg_test_sup", workspaceId: WS } });
  // The precedence case that a real migration hit: a person linked the old row
  // to a leg on an account that never migrated, and the rules pass then guessed
  // a link for its successor. The guess must not win — a rules pass can re-make
  // its own link, and nobody can re-make one that vanished without telling them.
  await catalogDb.transferGroup.create({ data: { id: "tg_user_made", workspaceId: WS } });
  await catalogDb.transferGroup.create({ data: { id: "tg_rule_made", workspaceId: WS } });
  await catalogDb.label.create({
    data: { id: "app_label_test_sup", workspaceId: WS, name: "reimburse" },
  });

  // --- the old account -----------------------------------------------------
  // Two rows that are identical but for their ids: the case a (date, amount,
  // description) matcher cannot tell apart, and the reason pairing goes by id.
  await tx({ id: "trans_old_dup1", account: OLD, connection: CONN_OLD, date: "2025-03-01", amount: -8, description: "POS W/D" });
  await tx({ id: "trans_old_dup2", account: OLD, connection: CONN_OLD, date: "2025-03-01", amount: -8, description: "POS W/D" });
  // Carries every kind of user-owned metadata there is.
  await tx({
    id: "trans_old_rich", account: OLD, connection: CONN_OLD, date: "2025-03-02", amount: -40,
    description: "NEW WORLD", categoryId: CAT, categorySource: "user", merchantSource: "rule",
    taxYear: 2026, transferGroupId: "tg_test_sup",
  });
  // The other leg of that transfer. Both legs have successors, so the group
  // should come through the merge intact — a transfer is only a transfer while
  // it has two ends.
  await tx({
    id: "trans_old_rich2", account: OLD, connection: CONN_OLD, date: "2025-03-02", amount: 40,
    description: "TRANSFER IN", transferGroupId: "tg_test_sup",
  });
  // A rule-owned category, against a successor a *person* has since set: the
  // one case where the old row must lose.
  await tx({
    id: "trans_old_outranked", account: OLD, connection: CONN_OLD, date: "2025-03-03", amount: -12,
    description: "CAFE", categoryId: CAT, categorySource: "rule",
  });
  await tx({
    id: "trans_old_userlink", account: OLD, connection: CONN_OLD, date: "2025-03-05", amount: -30,
    description: "USER LINKED", transferGroupId: "tg_user_made",
  });
  // History the new account never received — before its first transaction.
  await tx({ id: "trans_old_only", account: OLD, connection: CONN_OLD, date: "2024-12-01", amount: -99, description: "OLD ONLY" });
  // Inside the overlap and claimed by nobody: the partial-backfill case.
  await tx({ id: "trans_old_unclaimed", account: OLD, connection: CONN_OLD, date: "2025-03-04", amount: -5, description: "UNCLAIMED" });

  await catalogDb.transactionLabel.create({
    data: { workspaceId: WS, transactionId: "trans_old_rich", labelId: "app_label_test_sup" },
  });
  await catalogDb.transactionConflict.create({
    data: { workspaceId: WS, transactionId: "trans_old_rich", field: "category", heldSource: "user" },
  });
  await catalogDb.fieldChange.create({
    data: { workspaceId: WS, transactionId: "trans_old_rich", field: "category", source: "user", toLabel: "Supermarket" },
  });
  await catalogDb.fieldChange.create({
    data: { workspaceId: WS, transactionId: "trans_old_userlink", field: "transfer", source: "user", toLabel: "FAR USER LEG" },
  });
  await catalogDb.fieldChange.create({
    data: { workspaceId: WS, transactionId: "trans_new_userlink", field: "transfer", source: "rule", toLabel: "FAR RULE LEG" },
  });
  await catalogDb.balanceSnapshot.create({
    data: { workspaceId: WS, accountId: OLD, currency: "NZD", current: 10, capturedAt: day("2025-02-01") },
  });
  await catalogDb.balanceSnapshot.create({
    // Same day as one the successor has: the unique constraint means one must go.
    data: { workspaceId: WS, accountId: OLD, currency: "NZD", current: 20, capturedAt: day("2025-03-01") },
  });

  // --- the new account -----------------------------------------------------
  await tx({ id: "trans_new_dup1", account: NEW, connection: CONN_NEW, date: "2025-03-01", amount: -8, description: "POS W/D", migratedFromId: "trans_old_dup1" });
  await tx({ id: "trans_new_dup2", account: NEW, connection: CONN_NEW, date: "2025-03-01", amount: -8, description: "POS W/D", migratedFromId: "trans_old_dup2" });
  await tx({ id: "trans_new_rich", account: NEW, connection: CONN_NEW, date: "2025-03-02", amount: -40, description: "NEW WORLD", migratedFromId: "trans_old_rich" });
  await tx({
    id: "trans_new_outranked", account: NEW, connection: CONN_NEW, date: "2025-03-03", amount: -12,
    description: "CAFE", migratedFromId: "trans_old_outranked", categorySource: "user",
  });
  await tx({ id: "trans_new_rich2", account: NEW, connection: CONN_NEW, date: "2025-03-02", amount: 40, description: "TRANSFER IN", migratedFromId: "trans_old_rich2" });
  await tx({
    id: "trans_new_userlink", account: NEW, connection: CONN_NEW, date: "2025-03-05", amount: -30,
    description: "USER LINKED", migratedFromId: "trans_old_userlink", transferGroupId: "tg_rule_made",
  });
  // The far legs, so neither group is left singular by the swap alone.
  await tx({ id: "trans_far_user", account: NEW, connection: CONN_NEW, date: "2025-03-06", amount: 30, description: "FAR USER LEG", transferGroupId: "tg_user_made" });
  await tx({ id: "trans_far_rule", account: NEW, connection: CONN_NEW, date: "2025-03-06", amount: 30, description: "FAR RULE LEG", transferGroupId: "tg_rule_made" });
  // No predecessor and after the cutover: genuinely new, must be left alone.
  await tx({ id: "trans_new_native", account: NEW, connection: CONN_NEW, date: "2025-03-10", amount: -7, description: "NATIVE" });
  // The shape-match for `trans_old_unclaimed`, which only --fallback heuristic finds.
  await tx({ id: "trans_new_unclaimed", account: NEW, connection: CONN_NEW, date: "2025-03-04", amount: -5, description: "UNCLAIMED" });

  await catalogDb.balanceSnapshot.create({
    data: { workspaceId: WS, accountId: NEW, currency: "NZD", current: 250, capturedAt: day("2025-03-01") },
  });
});

after(drop);

describe("proposeSupersessions", () => {
  test("takes the pair Akahu names, and skips a predecessor we never held", async () => {
    const pairs = await proposeSupersessions(db);
    assert.deepEqual(pairs, [{ oldId: OLD, newId: NEW }]);
  });
});

describe("planSupersession", () => {
  test("pairs by Akahu's id, telling identical rows apart 1:1", async () => {
    const plan = await planSupersession(db, { oldId: OLD, newId: NEW });

    const pairs = plan.duplicates
      .map((p) => `${p.old.id}->${p.next.id}`)
      .sort();
    // The two identical POS rows map to one successor each, not both to one.
    assert.ok(pairs.includes("trans_old_dup1->trans_new_dup1"));
    assert.ok(pairs.includes("trans_old_dup2->trans_new_dup2"));
    assert.equal(plan.duplicates.length, 6);
    assert.ok(plan.duplicates.every((p) => p.via === "migrated"));
  });

  test("by default nothing unpaired is moved or deleted", async () => {
    const plan = await planSupersession(db, { oldId: OLD, newId: NEW });
    // Both kinds of leftover stay put: the one predating the successor and the
    // one inside its range. Neither is a duplicate of anything.
    assert.deepEqual(plan.retained.map((m) => m.id).sort(), [
      "trans_old_only",
      "trans_old_unclaimed",
    ]);
    assert.deepEqual(plan.moves, []);
  });

  test("but the overlap leftover is singled out, being the one that may yet clash", async () => {
    const plan = await planSupersession(db, { oldId: OLD, newId: NEW });
    // `trans_old_only` predates the successor, so its absence is just history.
    assert.deepEqual(plan.unclaimed.map((m) => m.id), ["trans_old_unclaimed"]);
  });

  test("--fallback heuristic pairs it by shape instead", async () => {
    const plan = await planSupersession(db, { oldId: OLD, newId: NEW, fallback: "heuristic" });
    assert.deepEqual(plan.unclaimed, []);
    const guessed = plan.duplicates.filter((p) => p.via === "heuristic");
    assert.deepEqual(guessed.map((p) => `${p.old.id}->${p.next.id}`), [
      "trans_old_unclaimed->trans_new_unclaimed",
    ]);
    // The row predating the successor is never a shape candidate — there is
    // nothing in range for it to be a duplicate of — so it is still retained.
    assert.deepEqual(plan.retained.map((m) => m.id), ["trans_old_only"]);
  });

  test("--fallback move consolidates instead of deleting", async () => {
    const plan = await planSupersession(db, { oldId: OLD, newId: NEW, fallback: "move" });
    assert.deepEqual(plan.retained, []);
    assert.deepEqual(plan.moves.map((m) => m.id).sort(), ["trans_old_only", "trans_old_unclaimed"]);
    // Moving one does not make it accounted for: it is still the row Akahu may
    // re-issue, and the report has to be able to say so.
    assert.deepEqual(plan.unclaimed.map((m) => m.id), ["trans_old_unclaimed"]);
  });

  test("refuses a self-merge, and a successor that is itself a tombstone", async () => {
    await assert.rejects(() => planSupersession(db, { oldId: OLD, newId: OLD }), /cannot supersede itself/);
    await assert.rejects(
      () => planSupersession(db, { oldId: OLD, newId: "acc_not_here" }),
      /No account acc_not_here/,
    );
  });
});

describe("applySupersession", () => {
  test("merges: the duplicates go, the unmatched history stays", async (t) => {
    const plan = await planSupersession(db, { oldId: OLD, newId: NEW });
    const result = await applySupersession(db, plan);

    assert.equal(result.duplicatesRemoved, 6);
    assert.equal(result.transactionsRetained, 2);
    assert.equal(result.transactionsMoved, 0);

    await t.test("the superseded account keeps exactly what nothing claimed", async () => {
      // The invariant every untouched aggregation query depends on: what is left
      // here exists nowhere else, so counting it is right rather than double.
      const left = await db.transaction.findMany({
        where: { accountId: OLD },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      assert.deepEqual(left.map((r) => r.id), ["trans_old_only", "trans_old_unclaimed"]);
    });

    await t.test("and they keep the old account's connection, not the survivor's", async () => {
      const kept = await db.transaction.findFirst({ where: { id: "trans_old_only" } });
      assert.equal(kept?.connectionId, CONN_OLD);
    });

    await t.test("and is marked, so balance queries can drop it", async () => {
      const old = await db.account.findFirst({ where: { id: OLD } });
      assert.equal(old?.supersededById, NEW);
      assert.ok(old?.supersededAt instanceof Date);
    });

    await t.test("the survivor keeps every row of its own, and gains none", async () => {
      // Its 10, untouched: a merge only ever deletes on the old side.
      assert.equal(await db.transaction.count({ where: { accountId: NEW } }), 10);
    });

    await t.test("nothing the workspace held is lost", async () => {
      // 8 old + 10 new, less the 6 Akahu itself called the same row twice.
      assert.equal(await db.transaction.count({}), 12);
    });

    await t.test("user and rule enrichment carries onto the successor", async () => {
      const rich = await db.transaction.findFirst({ where: { id: "trans_new_rich" } });
      assert.equal(rich?.categoryId, CAT);
      assert.equal(rich?.categorySource, "user");
      assert.equal(rich?.categoryGroupId, GROUP);
      assert.equal(rich?.merchantSource, "rule");
      assert.equal(rich?.taxYear, 2026);
      assert.equal(rich?.transferGroupId, "tg_test_sup");
    });

    await t.test("but a rule never overwrites what a person set", async () => {
      const outranked = await db.transaction.findFirst({ where: { id: "trans_new_outranked" } });
      assert.equal(outranked?.categorySource, "user");
      assert.equal(outranked?.categoryId, null, "the rule's category must not land on a user-owned field");
    });

    await t.test("labels move across", async () => {
      const labels = await db.transactionLabel.findMany({ where: { transactionId: "trans_new_rich" } });
      assert.deepEqual(labels.map((l) => l.labelId), ["app_label_test_sup"]);
    });

    await t.test("open conflicts follow the value they are about", async () => {
      const conflicts = await db.transactionConflict.findMany({ where: { transactionId: "trans_new_rich" } });
      assert.equal(conflicts.length, 1);
    });

    await t.test("the audit log is repointed, not orphaned", async () => {
      assert.equal(await db.fieldChange.count({ where: { transactionId: "trans_old_rich" } }), 0);
      assert.ok((await db.fieldChange.count({ where: { transactionId: "trans_new_rich" } })) > 0);
    });

    await t.test("balance history is kept where it does not collide", async () => {
      const snapshots = await db.balanceSnapshot.findMany({
        where: { accountId: NEW },
        orderBy: { capturedAt: "asc" },
      });
      // The old account's 1 Feb reaches further back and survives; its 1 Mar
      // collided with the successor's own, and the successor's is the right one.
      assert.deepEqual(
        snapshots.map((s) => [s.capturedAt.toISOString().slice(0, 10), Number(s.current)]),
        [["2025-02-01", 10], ["2025-03-01", 250]],
      );
      assert.equal(await db.balanceSnapshot.count({ where: { accountId: OLD } }), 0);
    });

    await t.test("a transfer survives the merge with both legs", async () => {
      const legs = await db.transaction.findMany({
        where: { transferGroupId: "tg_test_sup" },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      // Both legs repointed to the same group, so it is still a transfer — and
      // the ids are the successors', the predecessors having been deleted.
      assert.deepEqual(legs.map((l) => l.id), ["trans_new_rich", "trans_new_rich2"]);
    });

    await t.test("a user's transfer link beats a rule's on the successor", async () => {
      const row = await db.transaction.findFirst({ where: { id: "trans_new_userlink" } });
      assert.equal(
        row?.transferGroupId,
        "tg_user_made",
        "the rules pass guessed a link for the successor; the person's link must win",
      );
    });

    await t.test("nothing is left claiming to be a transfer of one", async () => {
      const groups = await db.transferGroup.findMany({
        select: { id: true, _count: { select: { transactions: true } } },
      });
      assert.deepEqual(groups.filter((g) => g._count.transactions < 2), []);
    });
  });

  // The reason a merge can be run against a half-finished backfill at all: what
  // it could not resolve today, it resolves on the next pass.
  test("a re-run deletes a successor that only arrived later", async (t) => {
    // Akahu finally re-issues the row that had no successor at the first merge.
    await tx({
      id: "trans_new_latecomer", account: NEW, connection: CONN_NEW, date: "2025-03-04",
      amount: -5, description: "UNCLAIMED", migratedFromId: "trans_old_unclaimed",
    });

    await t.test("--auto offers the pair again while the tombstone holds rows", async () => {
      assert.deepEqual(await proposeSupersessions(db), [{ oldId: OLD, newId: NEW }]);
    });

    const before = await db.account.findFirst({ where: { id: OLD } });
    const plan = await planSupersession(db, { oldId: OLD, newId: NEW });
    assert.deepEqual(plan.duplicates.map((p) => p.old.id), ["trans_old_unclaimed"]);
    const result = await applySupersession(db, plan);
    assert.equal(result.duplicatesRemoved, 1);

    await t.test("only the row nothing ever claimed is still there", async () => {
      const left = await db.transaction.findMany({ where: { accountId: OLD }, select: { id: true } });
      assert.deepEqual(left.map((r) => r.id), ["trans_old_only"]);
      // And it is no longer flagged: it predates the successor, so no backfill
      // is ever going to produce a twin for it.
      assert.deepEqual(plan.unclaimed, []);
    });

    await t.test("the merge keeps its original date", async () => {
      const after = await db.account.findFirst({ where: { id: OLD } });
      assert.deepEqual(after?.supersededAt, before?.supersededAt);
    });
  });

  test("refuses a pair whose predecessor was merged somewhere else", async () => {
    await assert.rejects(
      () => planSupersession(db, { oldId: OLD, newId: DANGLING }),
      /already superseded by/,
    );
  });
});
