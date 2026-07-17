import "server-only";
import { connection } from "next/server";
import { getDb } from "../db";

// One transaction's field change log, for the History panel on its page. The
// write side lives in lib/server/changes.ts; this is the only reader of it
// outside the rule-run report (which reads the same table filtered to one run —
// see queries/runs.ts).

export type HistoryEntry = {
  id: string;
  field: string;
  source: string;
  /** The person who made it, when there was one and they still exist. */
  actorName: string | null;
  /** Set when a rule made it, so the entry can link to that run's report. */
  ruleRunId: string | null;
  fromLabel: string | null;
  toLabel: string | null;
  createdAt: Date;
};

/**
 * Every recorded change to one transaction's enrichment, newest first.
 *
 * Returns an empty list for most transactions and that is correct, not a bug:
 * the log records changes from the day it shipped, and nothing was backfilled
 * for the sync and the user because there was no honest timestamp to backfill
 * *with* — only rule history carried one. A transaction nobody has touched since
 * has no history to show.
 */
export async function getTransactionHistory(transactionId: string): Promise<HistoryEntry[]> {
  await connection();
  const db = await getDb();

  const rows = await db.fieldChange.findMany({
    where: { transactionId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      field: true,
      source: true,
      ruleRunId: true,
      fromLabel: true,
      toLabel: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    field: row.field,
    source: row.source,
    actorName: row.actor?.name ?? null,
    ruleRunId: row.ruleRunId,
    fromLabel: row.fromLabel,
    toLabel: row.toLabel,
    createdAt: row.createdAt,
  }));
}
