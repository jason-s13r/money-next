"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { isTaxYearStart, TAX_YEAR_START_DAY_MAX } from "@/lib/server/tax-year";
import type { TaxYearResult } from "./types";

/**
 * Move the start of this workspace's tax year.
 *
 * Owner-only, through `organization: ["update"]` — the statement Better Auth
 * already defines for "change something about the workspace itself". This is not
 * enrichment: it does not describe one transaction, it silently re-buckets every
 * one of them at once, which is a different-sized decision and belongs with the
 * role that can rename or delete the workspace.
 *
 * Written through the scoped client, which passes `Workspace` through unfiltered
 * — it is the row the scope is *named by*, neither tenant-filtered nor part of the
 * control plane (see lib/server/db/scoped.ts). What makes that safe is where the
 * id comes from: `$workspaceId`, off the client itself, resolved by `getDb` from
 * the session and the URL. There is no id here for a caller to point elsewhere.
 * The read side does the same, in `taxYearFor`.
 *
 * No history row. `FieldChange` is a per-transaction log and this is not a
 * transaction — and unlike a rename, nothing about the old value is lost: the
 * setting is the whole of the fact, and reading it back tells you what it is.
 */
export async function setTaxYearStart(
  startMonth: number,
  startDay: number,
): Promise<TaxYearResult> {
  await requireRole({ organization: ["update"] });

  // The bounds are the domain's, not the form's: `startDay` stops at 28 because
  // a later day does not exist in some month or some year, and there is no
  // non-arbitrary answer to where the year then begins. See `isTaxYearStart`.
  if (!isTaxYearStart(startMonth, startDay)) {
    return {
      ok: false,
      reason: `Pick a month and a day from 1 to ${TAX_YEAR_START_DAY_MAX}.`,
    };
  }

  const db = await getDb();
  await db.workspace.update({
    where: { id: db.$workspaceId },
    data: { taxYearStartMonth: startMonth, taxYearStartDay: startDay },
  });

  // Every view that can be sliced by tax year, plus the page that was just
  // edited. Harmless today — every read awaits `connection()`, so nothing is
  // cached to go stale — and the list that a `"use cache"` would need.
  for (const path of ["/settings", "/", "/breakdown", "/breakdown/flow", "/budgets/breakdown"]) {
    await revalidateWorkspacePath(path);
  }

  return { ok: true, startMonth, startDay };
}
