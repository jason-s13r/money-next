"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/server/db";
import { runRules, defaultDecisionGraph } from "@/lib/server/rules/engine";
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
  const base = slugify(name) || "rules";
  let slug = base;
  for (let n = 2; ; n++) {
    if (!(await db.ruleDocument.findUnique({ where: { slug } }))) return slug;
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
  const existing = await db.ruleDocument.findFirst({ where: { active: true } });
  if (existing) return existing;

  const doc = await db.ruleDocument.create({
    data: {
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
  const doc = await getOrCreateActiveDocument();
  const graph = JSON.parse(doc.content) as Graph;
  mutate(graph);
  await db.ruleDocument.update({ where: { id: doc.id }, data: { content: JSON.stringify(graph) } });
  revalidatePath("/rules");
}

/**
 * Backfill: evaluate the active document against *every* transaction and apply
 * the results — the manual counterpart to the automatic per-sync pass. Returns
 * the summary so the button can report what changed.
 */
export async function applyRulesNow() {
  const summary = await runRules({ trigger: "manual" });
  revalidatePath("/rules");
  revalidatePath("/rules/runs");
  revalidatePath("/transactions/recent");
  revalidatePath("/");
  return summary;
}

/** Delete a learned rule (a row in the decision table) by its id. */
export async function removeRule(ruleId: string) {
  await editActiveGraph((graph) => deleteLearnedRule(graph, ruleId));
}

/** Turn transfer auto-linking on or off. */
export async function toggleTransfersAutoLink(enabled: boolean) {
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

  const matchCount = await db.transaction.count({
    where: {
      type: tx.type,
      AND: match.tokens.map((t) => ({ description: { contains: t } })),
    },
  });

  revalidatePath("/rules");
  revalidatePath(`/transactions/${transactionId}`);
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
