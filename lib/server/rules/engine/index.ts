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
import type { FieldChangeEntry } from "../../changes";
import type { ScopedDb } from "../../db";
import { ruleLabelName, tagTransactions } from "../../labels";
import { learnedTable, normalizeTable, type Graph } from "../learning/graph";
import { money } from "../../money";
import {
  RULE_SOURCE,
  type RuleOutput,
  type RuleTx,
  type RulesRunSummary,
  txSelect,
} from "./types";
import { buildInput } from "./input";
import { applyOutput } from "./apply";

export { defaultDecisionGraph } from "./graph";
export type { RuleInput, RuleOutput, RulesRunSummary } from "./types";

// Chunk size for each `id: { in: [...] }` batch. Originally sized to stay under
// SQLite's 999 bound-parameter ceiling; Postgres' limit is far higher, but a
// large sync can hand this thousands of ids and batching them is good hygiene on
// any database, so the number stays.
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
export async function runRules(
  // Taken as a parameter rather than resolved here: the two callers resolve the
  // workspace differently — a server action from the session, the ingest from
  // the bank link it is syncing — and this runs in plain Node as well as in a
  // request, where there is no session to reach for.
  db: ScopedDb,
  opts?: {
    transactionIds?: string[];
    /** What triggered the run, for the log. Defaults to `manual`. */
    trigger?: "sync" | "manual";
    /**
     * A pre-created, worker-claimed RuleRun (`queued` → `running`) to finalise in
     * place, used by the queued manual backfill (phase 7). When set, this call
     * updates that row rather than creating its own, and on failure throws without
     * writing a terminal state — the worker owns retry-or-fail, exactly as the sync
     * queue works. Omit it and the call owns its row (the per-sync pass).
     */
    runId?: string;
  },
): Promise<RulesRunSummary> {
  const trigger = opts?.trigger ?? "manual";
  const runId = opts?.runId;
  const startedAt = new Date();
  // Every edit made this run, recorded against the RuleRun at the end.
  const changes: FieldChangeEntry[] = [];
  // The tags this run wants to write, by label name — collected as it goes and
  // written in one pass per name at the end, so a name shared by a thousand
  // transactions is one insert rather than a thousand.
  const wanted = new Map<string, string[]>();
  // Which of those names a rule asked for by hand, rather than being derived from
  // what changed. Only these are worth a row in the change log.
  const explicit = new Set<string>();
  const summary: RulesRunSummary = {
    ran: false,
    evaluated: 0,
    categorised: 0,
    merchantsSet: 0,
    transfersLinked: 0,
    errors: 0,
  };

  // Write the run's *success* outcome. With `runId` the row already exists (the
  // worker claimed it): update it in place, and always — a queued run must resolve
  // even when it changed nothing, or `/rules` would poll it forever. Without a
  // runId this is the per-sync pass, which logs only when it actually did
  // something, so the log stays a record of changes rather than a heartbeat.
  //
  // Only the success path lives here. A failure throws; for a queued run the worker
  // records it (with backoff), so the row is never written by both.
  const finalizeSuccess = async () => {
    const data = {
      status: "success" as const,
      finishedAt: new Date(),
      evaluated: summary.evaluated,
      categorised: summary.categorised,
      merchantsSet: summary.merchantsSet,
      transfersLinked: summary.transfersLinked,
      errors: summary.errors,
      // The run's edits go straight into the field change log, nested so they
      // commit with the run and inherit its id as `ruleRunId` — which is what
      // `/rules/runs/<id>` reads back. `source` says which of the three writers
      // this was; no `actorUserId`, even on a manual run: the person asked for the
      // rules to run, they did not choose this edit. `RuleRun.trigger` records that
      // they asked. Nested creates are outside what the scoped client rewrites — it
      // only stamps the top-level `data` — so these carry the workspace themselves.
      changes: {
        create: changes.map((c) => ({ ...c, workspaceId: db.$workspaceId, source: RULE_SOURCE })),
      },
    };
    if (runId) {
      await db.ruleRun.update({ where: { id: runId }, data });
    } else if (changes.length > 0 || summary.errors > 0) {
      await db.ruleRun.create({ data: { workspaceId: db.$workspaceId, startedAt, trigger, ...data } });
    }
  };

  const doc = await db.ruleDocument.findFirst({
    where: { active: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!doc) {
    // No active graph (e.g. every rule was deleted between enqueue and pickup).
    // Nothing to apply — resolve a queued row as an empty success.
    if (runId) await finalizeSuccess();
    return summary;
  }
  if (opts?.transactionIds && opts.transactionIds.length === 0) {
    summary.ran = true;
    if (runId) await finalizeSuccess();
    return summary;
  }
  summary.ran = true;

  const engine = new ZenEngine();
  let decision: ZenDecision;
  try {
    // Heal the stored table's columns before evaluating (see `normalizeTable`).
    // In memory only: a document written before a column existed carries rows the
    // engine would silently skip, and this makes them run without waiting for
    // someone to edit each one. Straight from ../learning/graph rather than the
    // barrel — that carries `server-only`, and this runs in the worker too.
    const graph = JSON.parse(doc.content) as Graph;
    const table = learnedTable(graph);
    if (table) normalizeTable(table);
    decision = engine.createDecision(graph);
  } catch (error) {
    engine.dispose();
    const message = error instanceof Error ? error.message : String(error);
    // A queued run's failure is the worker's to record (with retry/backoff); only
    // the self-owned per-sync path writes its own failed row here, so a broken
    // graph is still visible in the log.
    if (!runId) {
      await db.ruleRun.create({
        data: {
          workspaceId: db.$workspaceId,
          startedAt,
          finishedAt: new Date(),
          trigger,
          status: "failed",
          error: message,
        },
      });
    }
    throw new Error(`Active rule document "${doc.name}" is not a valid decision graph: ${message}`);
  }

  try {
    // A sync can hand us thousands of freshly-upserted ids; splatting them all
    // into one `id: { in: [...] }` makes a statement no database enjoys, so fetch
    // in chunks. (The chunk size was originally SQLite's 999 bound-parameter
    // ceiling; Postgres' limit is far higher, but batching a large IN list is
    // good hygiene regardless.) When no ids are given (the manual backfill) it's
    // a single query.
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
      // Out of `Decimal` here, so the graph input and everything downstream of it
      // sees a plain number (see `RuleTx`).
      txs.push(...batch.map((row) => ({ ...row, amount: money(row.amount) })));
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
        const made = await applyOutput(db, tx, output);
        for (const change of made) {
          changes.push({ transactionId: tx.id, ...change });
          if (change.field === "category") summary.categorised++;
          else if (change.field === "merchant") summary.merchantsSet++;
          else if (change.field === "transfer") summary.transfersLinked++;
        }
        // Tag only what actually changed, and name the tag after the change: one
        // bucket per category/merchant a rule set, rather than one pile for every
        // rule there has ever been. A rule that names its own label says so
        // instead — a deliberate name beats a derived one, so it replaces them.
        if (made.length > 0) {
          // Trimmed and type-checked rather than trusted: the graph is authorable,
          // and a label name is written straight into a row people then browse by.
          const own = typeof output.labelName === "string" ? output.labelName.trim() : "";
          let names: string[];
          if (own) {
            names = [own];
            explicit.add(own);
          } else {
            names = made.map(ruleLabelName).filter((n): n is string => n !== null);
          }
          for (const name of new Set(names)) {
            const ids = wanted.get(name);
            if (ids) ids.push(tx.id);
            else wanted.set(name, [tx.id]);
          }
        }
      } catch {
        summary.errors++;
      }
    }
  } finally {
    engine.dispose();
  }

  // Write the tags collected above. Only transactions this run really changed are
  // in there (`applyOutput` returns nothing when a rule left a field as-is), so a
  // re-run over the whole workspace re-tags nothing it didn't touch this time, and
  // `tagTransactions` skips any that already carry the tag from a prior run.
  //
  // A rule's *own* label is logged as a change, because a person configured it and
  // will want to see it in the run report; the derived `category-rule-…` tags are
  // not, because the `category` row beside them already records that edit and a
  // second row for the tag it implies would double every run's count.
  //
  // Best-effort: the field edits are already committed and the run's own log is
  // written by `finalizeSuccess` below, so a failed tag write must not fail the
  // run or lose that log — it is a marker, not the record. Swallowed with a warn,
  // the same way the per-transaction evaluate/apply is counted and stepped over.
  for (const [name, ids] of wanted) {
    try {
      const tagged = await tagTransactions(db, name, ids);
      if (explicit.has(name)) {
        for (const transactionId of tagged) {
          changes.push({ transactionId, field: "label", toLabel: name });
        }
      }
    } catch (error) {
      console.warn(`rules: failed to tag ${ids.length} transaction(s) with "${name}":`, error);
    }
  }

  await finalizeSuccess();
  return summary;
}
