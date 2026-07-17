import "server-only";

import { connection } from "next/server";
import { getDb } from "../../db";
import { money } from "../../money";
import { UNCATEGORISED_WHERE } from "../../queries/transactions";
import { type ReviewQueue } from "./types";

/**
 * Spending with no `categoryId` — no specific NZFCC category, whether or not a
 * group was inferred. It is counted in the totals but belongs to no category, so
 * it is the queue a future classification step works through. Income is excluded:
 * its own uncategorised inflows are surfaced under the Income breakdown instead.
 *
 * Transfers are excluded on the same two tests used everywhere else — Akahu's
 * tagged `type` and the groups a user linked by hand (`transferGroupId`) — so
 * this count matches the uncategorised page it links to.
 */
export async function getReviewQueue(percentile = 0.90): Promise<ReviewQueue> {
  await connection();
  const db = await getDb();
  const rows = await db.transaction.findMany({
    where: UNCATEGORISED_WHERE,
    select: { amount: true },
  });

  if (rows.length === 0) {
    return { rows: 0, overThreshold: 0, threshold: null };
  }

  const amounts = rows.map((r) => Math.abs(money(r.amount))).toSorted((a, b) => a - b);
  // Nearest-rank: the smallest amount with at least `percentile` of the queue at
  // or below it. Clamped so the last index is never overrun.
  const rank = Math.min(amounts.length - 1, Math.ceil(percentile * amounts.length) - 1);
  const threshold = amounts[Math.max(0, rank)];

  return {
    rows: rows.length,
    overThreshold: amounts.filter((a) => a >= threshold).length,
    threshold,
  };
}
