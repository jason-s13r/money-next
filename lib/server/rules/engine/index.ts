// Transaction automation, powered by the GoRules Zen engine. The active
// `RuleDocument` holds a JDM decision graph authored in the visual editor at
// `/rules`; here we evaluate every transaction against it and apply what it
// decides — a category, a merchant, or the go-ahead to auto-link a transfer.
//
// No `import "server-only"`: this runs both inside the request (the manual
// "apply rules" action, and the per-sync pass) and inside the plain-Node ingest
// script, exactly like lib/server/sync.ts. `@gorules/zen-engine` is a native
// addon and is kept out of the Next bundle via `serverExternalPackages`.
//
// Types live in `types.ts`, input building in `input.ts`, output application in
// `apply.ts`, and the starter graph in `graph.ts`.

import { ZenEngine, type ZenDecision } from "@gorules/zen-engine";
import { db } from "../../db";
import {
  RULE_SOURCE,
  type RuleChange,
  type RuleOutput,
  type RuleTx,
  type RulesRunSummary,
  txSelect,
} from "./types";
import { buildInput } from "./input";
import { applyOutput } from "./apply";

export { defaultDecisionGraph } from "./graph";
export type { RuleInput, RuleOutput, RulesRunSummary } from "./types";

// Keep each `id: { in: [...] }` batch well under SQLite's default bound-parameter
// ceiling (999) so a large sync's id list can't overflow it.
const ID_QUERY_CHUNK = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Evaluate the active decision against a set of transactions (or all of them when
 * `transactionIds` is omitted) and apply each result. Used two ways: the manual
 * backfill from `/rules`, and the per-sync pass over freshly-ingested rows.
 *
 * Builds the engine once and disposes it at the end; a per-transaction failure is
 * counted and stepped over rather than aborting the batch.
 */
export async function runRules(opts?: {
  transactionIds?: string[];
  /** What triggered the run, for the log. Defaults to `manual`. */
  trigger?: "sync" | "manual";
}): Promise<RulesRunSummary> {
  const trigger = opts?.trigger ?? "manual";
  const doc = await db.ruleDocument.findFirst({
    where: { active: true },
    orderBy: { updatedAt: "desc" },
  });
  const summary: RulesRunSummary = {
    ran: false,
    evaluated: 0,
    categorised: 0,
    merchantsSet: 0,
    transfersLinked: 0,
    errors: 0,
  };
  if (!doc) return summary;
  if (opts?.transactionIds && opts.transactionIds.length === 0) {
    summary.ran = true;
    return summary;
  }
  summary.ran = true;

  const startedAt = new Date();
  const engine = new ZenEngine();
  let decision: ZenDecision;
  try {
    decision = engine.createDecision(JSON.parse(doc.content));
  } catch (error) {
    engine.dispose();
    const message = error instanceof Error ? error.message : String(error);
    // Record the failure so a persistently-broken graph is visible in the log.
    await db.ruleRun.create({
      data: { startedAt, finishedAt: new Date(), trigger, status: "failed", error: message },
    });
    throw new Error(`Active rule document "${doc.name}" is not a valid decision graph: ${message}`);
  }

  // Every edit made this run, recorded against the RuleRun at the end.
  const applications: { transactionId: string; field: string; fromLabel: string | null; toLabel: string | null }[] = [];

  try {
    // A sync can hand us thousands of freshly-upserted ids; splatting them all
    // into one `id: { in: [...] }` blows SQLite's bound-parameter limit, so fetch
    // in chunks. When no ids are given (the manual backfill) it's a single query.
    const txs: RuleTx[] = [];
    const idBatches = opts?.transactionIds
      ? chunk(opts.transactionIds, ID_QUERY_CHUNK)
      : [undefined];
    for (const ids of idBatches) {
      const batch = await db.transaction.findMany({
        where: ids ? { id: { in: ids } } : {},
        select: txSelect,
        orderBy: [{ date: "desc" }, { id: "desc" }],
      });
      txs.push(...batch);
    }
    // Each batch is ordered, but the concatenation across batches isn't; restore
    // the global date-desc, id-desc order so a run is deterministic regardless of
    // how the id list was chunked.
    if (idBatches.length > 1) {
      txs.sort((a, b) =>
        b.date.getTime() - a.date.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    }

    for (const tx of txs) {
      summary.evaluated++;
      try {
        const response = await decision.evaluate(buildInput(tx));
        const output = (response.result ?? {}) as RuleOutput;
        for (const change of await applyOutput(tx, output)) {
          applications.push({ transactionId: tx.id, ...change });
          if (change.field === "category") summary.categorised++;
          else if (change.field === "merchant") summary.merchantsSet++;
          else if (change.field === "transfer") summary.transfersLinked++;
        }
      } catch {
        summary.errors++;
      }
    }
  } finally {
    engine.dispose();
  }

  // Log the run only when it actually did something (or hit errors), so the report
  // stays a record of changes rather than a heartbeat of every no-op sync.
  if (applications.length > 0 || summary.errors > 0) {
    await db.ruleRun.create({
      data: {
        startedAt,
        finishedAt: new Date(),
        trigger,
        status: "success",
        evaluated: summary.evaluated,
        categorised: summary.categorised,
        merchantsSet: summary.merchantsSet,
        transfersLinked: summary.transfersLinked,
        errors: summary.errors,
        applications: { create: applications },
      },
    });
  }

  return summary;
}
