// Where this workspace's tax year starts, read from the row the scope is named
// by. Worker-safe, and modelled on `displayFxFor` next door: a passed-in scoped
// client rather than the ambient request one, because a chat turn is detached
// from the request that started it and still asks for tax-year figures.
//
// No `import "server-only"`: the same reason `lib/server/budget/fx.ts` has none.

import type { ScopedDb } from "./db";
import { DEFAULT_TAX_YEAR, type TaxYear } from "../periods";

/**
 * The months a tax year may open in, and the days of them it may open on.
 *
 * 28 is the cap for every month rather than each month's own length. A start on
 * the 29th, 30th or 31st is a date that does not exist in some year — 29 February
 * most obviously, but also the 31st of a 30-day month — and there is no
 * non-arbitrary answer to where the year begins when it doesn't. No real tax
 * jurisdiction asks for one: the answers in the wild are the 1st and the UK's
 * 6 April.
 */
export const TAX_YEAR_START_DAY_MAX = 28;

/** Whether a month/day pair is one a tax year may start on. */
export function isTaxYearStart(startMonth: number, startDay: number): boolean {
  return (
    Number.isInteger(startMonth) &&
    Number.isInteger(startDay) &&
    startMonth >= 1 &&
    startMonth <= 12 &&
    startDay >= 1 &&
    startDay <= TAX_YEAR_START_DAY_MAX
  );
}

/**
 * This workspace's tax year.
 *
 * `Workspace` is neither a tenant model nor part of the control plane, so the
 * scoped client passes the query straight through unfiltered — which is safe
 * here and only here: the id being looked up *is* the scope, taken from the
 * client rather than from anything a caller supplied.
 *
 * Falls back to the default if the row has somehow gone. That is a workspace
 * being deleted underneath a request in flight, and answering "1 April" is a
 * better end to that race than throwing out of a metrics build.
 */
export async function taxYearFor(db: ScopedDb): Promise<TaxYear> {
  const workspace = await db.workspace.findUnique({
    where: { id: db.$workspaceId },
    select: { taxYearStartMonth: true, taxYearStartDay: true },
  });
  if (!workspace) return DEFAULT_TAX_YEAR;

  return {
    startMonth: workspace.taxYearStartMonth,
    startDay: workspace.taxYearStartDay,
  };
}
