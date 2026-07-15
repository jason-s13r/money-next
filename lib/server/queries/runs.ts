import "server-only";
import { connection } from "next/server";
import { db } from "../db";

// The ingest and rules execution logs, for the /sync and /rules run-history pages,
// plus the last-successful-sync marker the chrome shows staleness from. Read-only
// like the rest of this layer; each awaits `connection()` first.

/** When the ingest task last completed, so the UI can show staleness. */
export async function getLastSync() {
  await connection();
  return db.syncRun.findFirst({
    where: { status: "success" },
    orderBy: { startedAt: "desc" },
  });
}

export const SYNC_RUNS_PER_PAGE = 25;

export const RULE_RUNS_PER_PAGE = 25;

/** Paginated history of every ingest run, newest first. */
export async function getSyncRuns(page: number) {
  await connection();
  const [items, total] = await Promise.all([
    db.syncRun.findMany({
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * SYNC_RUNS_PER_PAGE,
      take: SYNC_RUNS_PER_PAGE,
    }),
    db.syncRun.count(),
  ]);
  return { items, total };
}

/** The rules execution log — runs newest first, each with its edit count. */
export async function getRuleRuns(page: number) {
  await connection();
  const [items, total] = await Promise.all([
    db.ruleRun.findMany({
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * RULE_RUNS_PER_PAGE,
      take: RULE_RUNS_PER_PAGE,
      include: { _count: { select: { applications: true } } },
    }),
    db.ruleRun.count(),
  ]);
  return { items, total };
}

export type RuleApplicationRow = {
  id: number;
  field: string;
  fromLabel: string | null;
  toLabel: string | null;
  /** The transaction as it stands now, or null if it has since been deleted. */
  transaction: {
    id: string;
    date: Date;
    description: string;
    amount: number;
    currency: string | null;
    merchantName: string | null;
  } | null;
};

/**
 * One rule run with the transactions it edited. The applications carry the
 * change labels; the current transaction rows are joined back in (in bulk) so the
 * report can link to each and show its date/amount, tolerating a since-deleted one.
 */
export async function getRuleRun(id: number) {
  await connection();
  const run = await db.ruleRun.findUnique({
    where: { id },
    include: { applications: { orderBy: { id: "asc" } } },
  });
  if (!run) return null;

  const txIds = [...new Set(run.applications.map((a) => a.transactionId))];
  const rows = await db.transaction.findMany({
    where: { id: { in: txIds } },
    select: {
      id: true,
      date: true,
      description: true,
      amount: true,
      merchant: { select: { name: true } },
      account: { select: { currency: true } },
    },
  });
  const txById = new Map(rows.map((r) => [r.id, r]));

  const applications: RuleApplicationRow[] = run.applications.map((a) => {
    const tx = txById.get(a.transactionId);
    return {
      id: a.id,
      field: a.field,
      fromLabel: a.fromLabel,
      toLabel: a.toLabel,
      transaction: tx
        ? {
            id: tx.id,
            date: tx.date,
            description: tx.description,
            amount: tx.amount,
            currency: tx.account.currency,
            merchantName: tx.merchant?.name ?? null,
          }
        : null,
    };
  });

  return { run, applications };
}
