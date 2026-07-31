import "server-only";
import { connection } from "next/server";
import { getDb } from "../../db/request";
import type { Period } from "../../../periods";
import { buildComparison } from "./build";
import type { Comparison } from "./types";

export type { Comparison, PeriodBreakdown, SpendDetail } from "./types";
export { netOf, UNCATEGORISED, UNKNOWN_MERCHANT } from "./types";

/**
 * Income and spending per period, for the comparison view. Income is one bucket
 * (inflows carry no categories); spending is split by Akahu's `categoryGroup`,
 * with the ungrouped remainder surfaced as its own "Uncategorised" segment rather
 * than dropped — hiding it would make the totals look complete when they are not.
 *
 * This is the request-side entry point: it resolves the scoped client `buildComparison`
 * now takes as an argument. A caller with no request — a chat turn, which is detached
 * from the one that started it — calls the builder directly with its own client.
 */
export async function getComparison(
  period: Period,
  count: number,
  offset = 0,
  now: Date = new Date(),
): Promise<Comparison> {
  await connection();
  return buildComparison(await getDb(), period, count, offset, now);
}

