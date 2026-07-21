"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { defaultDecisionGraph } from "@/lib/server/rules/engine";
import {
  deriveMatch,
  upsertLearnedRule,
  deleteLearnedRule,
  setTransferAutoLink,
  type Graph,
} from "@/lib/server/rules/learning";
import { slugify } from "@/lib/slug";
import type { GenerateRuleResult } from "./types";

// Server actions behind `/rules`. The rules *engine* lives in lib/server/rules.ts
// and the graph read/write helpers in lib/server/rule-learning.ts; this file is
// the thin request-side layer that loads the one active decision document,
// mutates its graph, and revalidates the page.

/** A slug unique across documents, `-2`/`-3`… appended on collision. */
async function uniqueSlug(name: string): Promise<string> {
  const db = await getDb();
  const base = slugify(name) || "rules";
  let slug = base;
  for (let n = 2; ; n++) {
    // findFirst, not findUnique: a slug is only unique within a workspace now,
    // and the scoped client supplies the workspace half of that key.
    if (!(await db.ruleDocument.findFirst({ where: { slug } }))) return slug;
    slug = `${base}-${n}`;
  }
}

/**
 * The single active rule document, created (and activated) on first use so the
 * feature works from a standing start. Only one document is ever active; the app
 * no longer exposes multiple, but the schema still allows them, so this also
 * demotes any stragglers when it creates one.
 */
async function getOrCreateActiveDocument() {
  const db = await getDb();
  const existing = await db.ruleDocument.findFirst({ where: { active: true } });
  if (existing) return existing;

  const doc = await db.ruleDocument.create({
    data: {
      workspaceId: db.$workspaceId,
      name: "Automations",
      slug: await uniqueSlug("Automations"),
      content: JSON.stringify(defaultDecisionGraph()),
      active: true,
    },
  });
  await db.ruleDocument.updateMany({
    where: { id: { not: doc.id }, active: true },
    data: { active: false },
  });
  return doc;
}

/** Load the active graph, hand it to `mutate`, and persist the result. */
async function editActiveGraph(mutate: (graph: Graph) => void) {
  const db = await getDb();
  const doc = await getOrCreateActiveDocument();
  const graph = JSON.parse(doc.content) as Graph;
  mutate(graph);
  await db.ruleDocument.update({ where: { id: doc.id }, data: { content: JSON.stringify(graph) } });
  await revalidateWorkspacePath("/rules");
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
 * Coalesced: a backfill already waiting is reused rather than stacked, so mashing
 * the button doesn't pile up identical jobs. If that waiting run is a failed one
 * sitting out its retry backoff, a click is an explicit override — clear the
 * backoff so the worker takes it on the next poll instead of making them wait.
 */
export async function applyRulesNow() {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();
  const waiting = await db.ruleRun.findFirst({
    where: { status: "queued" },
    orderBy: { startedAt: "asc" },
  });
  if (waiting) {
    if (waiting.nextAttemptAt && waiting.nextAttemptAt > new Date()) {
      await db.ruleRun.update({ where: { id: waiting.id }, data: { nextAttemptAt: null } });
    }
  } else {
    await db.ruleRun.create({
      data: { workspaceId: db.$workspaceId, trigger: "manual", status: "queued" },
    });
  }

  await revalidateWorkspacePath("/rules");
  await revalidateWorkspacePath("/rules/runs");
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

  const doc = await getOrCreateActiveDocument();
  const graph = JSON.parse(doc.content) as Graph;
  const { merged } = upsertLearnedRule(graph, match, {
    categoryId: tx.categoryId,
    merchantId: tx.merchantId,
    label: tx.merchant?.name ?? tx.category?.name ?? undefined,
  });
  await db.ruleDocument.update({ where: { id: doc.id }, data: { content: JSON.stringify(graph) } });

  // `mode: "insensitive"` is what makes this count *true*, not just consistent.
  // The rule itself matches on `contains(lower(description), …)` (see
  // `buildMatch`), so a case-sensitive count here would promise the user a
  // smaller blast radius than the rule actually has.
  const matchCount = await db.transaction.count({
    where: {
      type: tx.type,
      AND: match.tokens.map((t) => ({
        description: { contains: t, mode: "insensitive" as const },
      })),
    },
  });

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
