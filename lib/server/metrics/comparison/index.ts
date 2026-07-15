import "server-only";
import { connection } from "next/server";
import { buildComparison } from "./build";

export type { Comparison, PeriodBreakdown, SpendDetail } from "./types";
export { netOf, UNCATEGORISED, UNKNOWN_MERCHANT } from "./types";

/**
 * Income and spending per period, for the comparison view. Income is one bucket
 * (inflows carry no categories); spending is split by Akahu's `categoryGroup`,
 * with the ungrouped remainder surfaced as its own "Uncategorised" segment rather
 * than dropped — hiding it would make the totals look complete when they are not.
 */
export async function getComparison(
  ...args: Parameters<typeof buildComparison>
): Promise<ReturnType<typeof buildComparison>> {
  await connection();
  return buildComparison(...args);
}

