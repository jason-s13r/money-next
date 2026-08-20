/**
 * How the comparison decides what is income and what is spending.
 *
 *   pnpm test
 *
 * The rule under test is that a transaction's *category* decides which side of the
 * ledger it falls on, and its *sign* decides only whether it adds to that side or
 * nets off it. The alternative — reading the sign alone — is the tempting one, and
 * it is wrong in both directions at once. A debit filed under an income category
 * (tax clawed back off interest earned) would be counted as spending that never
 * happened while the interest it was meant to reduce stayed at its gross figure;
 * a refund filed under Food would be counted as income while the groceries it gave
 * back stayed fully spent.
 *
 * Both failures are quiet. Nothing throws, no row disappears from a listing, and
 * the totals stay plausible — they are simply larger than the money that moved,
 * on every screen that reads this builder: the comparison table, the period cards,
 * the Sankey, and the chat tool that answers from the same numbers.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Prisma } from "../lib/generated/prisma/client";
import { buildComparison } from "../lib/server/metrics/comparison/build";
import { netOf, UNCATEGORISED } from "../lib/server/metrics/comparison/types";
import type { ScopedDb } from "../lib/server/db";

const FOOD = "group_nzfcc_food";
const PERIODIC_INCOME = "group_custom_periodic_income";

const GROUPS = [
  { id: FOOD, name: "Food" },
  { id: PERIODIC_INCOME, name: "Periodic Income" },
];

/** A row as `buildComparison` selects it. Amounts are signed like the column. */
type Row = {
  amount: number;
  groupId: string | null;
  category: string | null;
  merchant?: string | null;
  date?: string;
};

/** Midnight UTC is midday NZ, so the NZ day is unambiguous (see periods.test.ts). */
const DAY = "2026-05-15";

function rowsFor(rows: Row[]) {
  return rows.map((r) => {
    const group = GROUPS.find((g) => g.id === r.groupId);
    return {
      date: new Date(`${r.date ?? DAY}T00:00:00Z`),
      taxYear: null,
      amount: new Prisma.Decimal(r.amount),
      categoryGroup: group ? { name: group.name } : null,
      category: r.category ? { name: r.category } : null,
      merchant: r.merchant ? { name: r.merchant } : null,
      merchantId: null,
      logo: null,
      account: { currency: "NZD" },
    };
  });
}

/**
 * The queries `buildComparison` runs, answered from a fixed set of rows.
 *
 * A stub rather than a database because the question here is arithmetic, not
 * persistence: which bucket a row lands in and what the buckets sum to. The two
 * `aggregate` calls are told apart by which extreme they ask for, since they differ
 * only in that.
 */
function stubDb(rows: Row[]): ScopedDb {
  const selected = rowsFor(rows);
  const dates = selected.map((r) => r.date.getTime());

  const ranking = GROUPS.map((g) => ({
    categoryGroupId: g.id,
    _sum: {
      amount: new Prisma.Decimal(
        rows.filter((r) => r.groupId === g.id).reduce((sum, r) => sum + r.amount, 0),
      ),
    },
  }));

  return {
    $workspaceId: "ws_test",
    workspace: {
      findUnique: async () => ({ taxYearStartMonth: 4, taxYearStartDay: 1 }),
    },
    transaction: {
      findMany: async () => selected,
      // Only the spending ranking asks for this, and it excludes the income groups
      // itself — so answer with whatever it asked to be grouped by.
      groupBy: async ({ where }: { where?: { categoryGroupId?: { notIn?: string[] } } }) => {
        const excluded = new Set(where?.categoryGroupId?.notIn ?? []);
        return ranking.filter((r) => !excluded.has(r.categoryGroupId));
      },
      aggregate: async ({ _max }: { _max?: unknown }) =>
        _max
          ? { _max: { date: dates.length ? new Date(Math.max(...dates)) : null } }
          : { _min: { date: dates.length ? new Date(Math.min(...dates)) : null } },
    },
    categoryGroup: { findMany: async () => GROUPS },
    merchant: { findMany: async () => [] },
    account: { groupBy: async () => [{ currency: "NZD" }] },
    fxRate: { findMany: async () => [] },
  } as unknown as ScopedDb;
}

/** One month's breakdown, built over a window that ends after `DAY`. */
async function monthOf(rows: Row[]) {
  const comparison = await buildComparison(stubDb(rows), "month", 3, 0, new Date("2026-06-10T00:00:00Z"));
  const bucket = comparison.periods.find((p) => p.key === "2026-05");
  assert.ok(bucket, "the fixture's month is inside the window");
  return { comparison, bucket };
}

describe("a category decides the side, its sign decides the direction", () => {
  test("a debit filed under an income category nets off that income", async () => {
    // The user's case: a "pie tax" debit marked as Interest to offset the interest
    // earned. It belongs to Interest, and it makes Interest smaller.
    const { bucket } = await monthOf([
      { amount: 500, groupId: PERIODIC_INCOME, category: "Interest" },
      { amount: -120, groupId: PERIODIC_INCOME, category: "Interest" },
    ]);

    assert.equal(bucket.incomeDetail.get("Interest")?.total, 380);
    assert.equal(bucket.incomeTotal, 380);
    // And crucially it invented no spending on the way.
    assert.equal(bucket.spendTotal, 0);
    assert.equal(bucket.spend.size, 0);
  });

  test("a refund filed under a spending category nets off that spending", async () => {
    const { bucket } = await monthOf([
      { amount: -200, groupId: FOOD, category: "Groceries" },
      { amount: 50, groupId: FOOD, category: "Groceries" },
    ]);

    assert.equal(bucket.spend.get("Food"), 150);
    assert.equal(bucket.spendDetail.get("Food")?.get("Groceries")?.total, 150);
    assert.equal(bucket.spendTotal, 150);
    assert.equal(bucket.incomeTotal, 0);
  });

  test("the net is the money that actually moved", async () => {
    const { bucket } = await monthOf([
      { amount: 500, groupId: PERIODIC_INCOME, category: "Interest" },
      { amount: -120, groupId: PERIODIC_INCOME, category: "Interest" },
      { amount: -200, groupId: FOOD, category: "Groceries" },
      { amount: 50, groupId: FOOD, category: "Groceries" },
    ]);

    // 500 − 120 − 200 + 50. Splitting by sign would read this as 550 in and 320
    // out, overstating both sides while landing on the same net — which is what
    // makes it hard to spot from the net alone.
    assert.equal(bucket.incomeTotal, 380);
    assert.equal(bucket.spendTotal, 150);
    assert.equal(netOf(bucket), 230);
  });

  test("an income category that nets negative stays on the income side", async () => {
    const { bucket } = await monthOf([
      { amount: 20, groupId: PERIODIC_INCOME, category: "Interest" },
      { amount: -90, groupId: PERIODIC_INCOME, category: "Interest" },
    ]);

    assert.equal(bucket.incomeDetail.get("Interest")?.total, -70);
    assert.equal(bucket.incomeTotal, -70);
    assert.equal(bucket.spendTotal, 0);
  });
});

describe("without a category there is nothing but the sign to go on", () => {
  test("an uncategorised inflow is income and an uncategorised outflow is spending", async () => {
    const { bucket } = await monthOf([
      { amount: 300, groupId: null, category: null },
      { amount: -75, groupId: null, category: null },
    ]);

    assert.equal(bucket.incomeDetail.get(UNCATEGORISED)?.total, 300);
    assert.equal(bucket.spend.get(UNCATEGORISED), 75);
    assert.equal(netOf(bucket), 225);
  });
});
