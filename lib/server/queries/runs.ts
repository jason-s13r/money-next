import "server-only";
import { connection } from "next/server";
import { getDb } from "../db/request";
import { money } from "../money";

// The ingest and rules execution logs, for the /sync and /rules run-history pages,
// plus the last-successful-sync marker the chrome shows staleness from. Read-only
// like the rest of this layer; each awaits `connection()` first.

/** When the ingest task last completed, so the UI can show staleness. */
export async function getLastSync() {
  await connection();
  const db = await getDb();
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
  const db = await getDb();
  const [items, total] = await Promise.all([
    db.syncRun.findMany({
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * SYNC_RUNS_PER_PAGE,
      take: SYNC_RUNS_PER_PAGE,
      // Counted through the relation rather than stored on the row, so it can
      // never disagree with the transactions /sync/<id> lists.
      include: { _count: { select: { transactions: true } } },
    }),
    db.syncRun.count(),
  ]);
  return { items, total };
}

/**
 * One sync run, for `/sync/<id>`. The scoped client filters by workspace, so
 * another workspace's run is exactly as unknown as a made-up id.
 */
export async function getSyncRun(id: string) {
  await connection();
  const db = await getDb();
  return db.syncRun.findUnique({
    where: { id },
    include: { bankLink: { select: { name: true } } },
  });
}

/** The rules execution log — runs newest first, each with its edit count. */
export async function getRuleRuns(page: number) {
  await connection();
  const db = await getDb();
  const [items, total] = await Promise.all([
    db.ruleRun.findMany({
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * RULE_RUNS_PER_PAGE,
      take: RULE_RUNS_PER_PAGE,
      include: { _count: { select: { changes: true } } },
    }),
    db.ruleRun.count(),
  ]);
  return { items, total };
}

export type RuleApplicationRow = {
  id: string;
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
 * One rule run with the transactions it edited. The changes carry the labels; the
 * current transaction rows are joined back in (in bulk) so the report can link to
 * each and show its date/amount, tolerating a since-deleted one.
 *
 * This reads the field change log filtered to one run — the rows a rule wrote —
 * which is all `RuleApplication` ever was. The log holds the sync's and the
 * user's edits alongside them, but a run report only ever wanted its own.
 */
export async function getRuleRun(id: string) {
  await connection();
  const db = await getDb();
  const run = await db.ruleRun.findUnique({
    where: { id },
    include: { changes: { orderBy: { id: "asc" } } },
  });
  if (!run) return null;

  const txIds = [...new Set(run.changes.map((a) => a.transactionId))];
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
  const txById = new Map(rows.map((r) => [r.id, { ...r, amount: money(r.amount) }]));

  const applications: RuleApplicationRow[] = run.changes.map((a) => {
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

  // The table below lists one row per *change*, so a transaction whose category and
  // merchant were both set appears twice; the header says how many there really were.
  return { run, applications, transactionCount: txIds.length };
}
