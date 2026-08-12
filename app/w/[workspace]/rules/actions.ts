"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import type { ScopedDb } from "@/lib/server/db";
import { enqueueRules } from "@/lib/server/queue";
import { editRuleGraph } from "@/lib/server/rules/document";
import {
  deriveMatch,
  upsertLearnedRule,
  updateLearnedRule,
  validateEdit,
  deleteLearnedRule,
  setTransferAutoLink,
  type Graph,
  type RuleEdit,
} from "@/lib/server/rules/learning";
import type { GenerateRuleResult, UpdateRuleResult } from "./types";

// Server actions behind `/rules`. The rules *engine* lives in lib/server/rules/engine
// and the graph read/write helpers in lib/server/rules/learning; this file is the thin
// request-side layer that mutates the one active decision document and revalidates the
// page.
//
// Finding (and creating) that document moved to lib/server/rules/document.ts once the
// chat's rules tools became a second writer — a chat turn is detached from its request
// and holds its own scoped client, so it cannot use a helper that reaches for an
// ambient one. The revalidation stays here: it is `server-only`, and it is the half
// that is genuinely about being in a request.

/** Load the active graph, hand it to `mutate`, persist it, and refresh the page. */
async function editActiveGraph(mutate: (graph: Graph) => void) {
  const db = await getDb();
  await editRuleGraph(db, mutate);
  await revalidateWorkspacePath("/rules");
}

/**
 * How many stored transactions a predicate reaches — the blast radius shown when a
 * rule is taught or edited.
 *
 * `mode: "insensitive"` is what makes this count *true*, not just consistent. The
 * rule itself matches on `contains(lower(description), …)` (see `buildExpression`),
 * so a case-sensitive count here would promise a smaller reach than the rule
 * actually has.
 */
async function countMatching(
  db: ScopedDb,
  type: string | null,
  tokens: string[],
): Promise<number> {
  return db.transaction.count({
    where: {
      ...(type ? { type } : {}),
      AND: tokens.map((t) => ({
        description: { contains: t, mode: "insensitive" as const },
      })),
    },
  });
}

/**
 * Backfill: evaluate the active document against *every* transaction and apply the
 * results — the manual counterpart to the automatic per-sync pass.
 *
 * Enqueued, not run (phase 7): a whole-history pass is unbounded work, so running
 * it inside this request is the T14 rule-graph DoS seam. The button now writes a
 * `queued` RuleRun — a tenant INSERT `money_app` already holds — and the
 * `money_sync` worker (scripts/worker.ts) claims it, runs the pass, and finalises
 * the row. `/rules` polls it from queued → running → success like `/sync` does.
 *
 * Coalesced (`lib/server/queue`): a backfill already waiting is reused rather than
 * stacked, so mashing the button doesn't pile up identical jobs — and a pass the
 * ingest queued for itself is the same job, so a click behind one rides along with
 * it. If that waiting run is a failed one sitting out its retry backoff, a click is
 * an explicit override — `clearBackoff` drops the wait so the worker takes it on
 * the next poll.
 */
export async function applyRulesNow() {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  await enqueueRules(db, { trigger: "manual", clearBackoff: true });

  await revalidateWorkspacePath("/rules");
  await revalidateWorkspacePath("/rules/runs");
}

/**
 * Rewrite a learned rule: its tokens, the type it is gated on, and its outputs.
 *
 * A derived predicate keeps whatever the tokeniser thought was stable, which is
 * sometimes a reference that appears exactly once ("3cb-kensingtonh") — a rule that
 * looks right on the page and will never match again. Editing is the cheap fix for
 * that, and the returned count is how the person checks the fix landed.
 */
export async function updateRule(ruleId: string, edit: RuleEdit): Promise<UpdateRuleResult> {
  await requireRole({ enrichment: ["update"] });

  const validated = validateEdit(edit);
  if (!validated.ok) return validated;

  let found = false;
  const db = await getDb();
  await editRuleGraph(db, (graph) => {
    found = updateLearnedRule(graph, ruleId, validated.edit);
  });
  if (!found) return { ok: false, reason: "That rule no longer exists." };

  const matchCount = await countMatching(db, validated.edit.type, validated.edit.tokens);

  await revalidateWorkspacePath("/rules");
  return { ok: true, matchCount };
}

/** Delete a learned rule (a row in the decision table) by its id. */
export async function removeRule(ruleId: string) {
  await requireRole({ enrichment: ["update"] });

  await editActiveGraph((graph) => deleteLearnedRule(graph, ruleId));
}

/** Turn transfer auto-linking on or off. */
export async function toggleTransfersAutoLink(enabled: boolean) {
  await requireRole({ enrichment: ["update"] });

  await editActiveGraph((graph) => setTransferAutoLink(graph, enabled));
}

/**
 * Turn one hand-classified transaction into a durable rule. Derives a match
 * predicate from its description (see lib/server/rule-learning.ts), folds it into
 * the active document's "Learned rules" table, and reports how far it reaches.
 */
export async function generateRuleFromTransaction(
  transactionId: string,
): Promise<GenerateRuleResult> {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  const tx = await db.transaction.findUnique({
    where: { id: transactionId },
    select: {
      type: true,
      description: true,
      categoryId: true,
      category: { select: { name: true } },
      merchantId: true,
      merchant: { select: { name: true } },
    },
  });
  if (!tx) return { ok: false, reason: "Transaction not found." };
  if (!tx.categoryId && !tx.merchantId) {
    return { ok: false, reason: "Set a category or merchant on this transaction first." };
  }

  const match = deriveMatch(tx);
  if (!match) {
    return {
      ok: false,
      reason:
        "Couldn't find a stable word to match on — this description is all dates/numbers.",
    };
  }

  let merged = false;
  await editRuleGraph(db, (graph) => {
    merged = upsertLearnedRule(graph, match, {
      categoryId: tx.categoryId,
      merchantId: tx.merchantId,
      label: tx.merchant?.name ?? tx.category?.name ?? undefined,
    }).merged;
  });

  const matchCount = await countMatching(db, tx.type, match.tokens);

  await revalidateWorkspacePath("/rules");
  await revalidateWorkspacePath(`/transactions/${transactionId}`);
  return {
    ok: true,
    merged,
    expression: match.expression,
    tokens: match.tokens,
    categoryName: tx.categoryId ? tx.category?.name ?? null : null,
    merchantName: tx.merchantId ? tx.merchant?.name ?? null : null,
    matchCount,
  };
}
