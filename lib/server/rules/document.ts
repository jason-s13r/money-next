// The one active decision document, and the two things every writer does to it.
//
// This used to live inside `app/w/[workspace]/rules/actions.ts`, where it was
// reachable only from a request because it read `getDb()` for itself. There is a
// second writer now — the chat's rules tools — and a chat turn runs detached from
// the request that started it, so it holds its own scoped client and cannot reach
// for an ambient one. Taking the db as an argument is what lets both use the same
// "create it on first use, and only one is ever active" rule rather than two copies
// of it that quietly disagree about which document the runner will pick up.
//
// No `import "server-only"`: it shares a module graph with the chat tool registry,
// which the worker's budget inference loads. Nothing here needs a request.
//
// Revalidation is deliberately *not* here. `revalidateWorkspacePath` carries
// `server-only`, and only one of the two callers is in a request anyway — the
// actions revalidate for themselves after calling in.

import { slugify } from "../../slug";
import type { ScopedDb } from "../db";
// Straight from ./engine/graph rather than the engine's barrel: that one pulls in
// `@gorules/zen-engine`, a native addon, and a starter graph is a plain value.
import { defaultDecisionGraph } from "./engine/graph";
import type { Graph } from "./learning/graph";

/** A slug unique across a workspace's documents, `-2`/`-3`… appended on collision. */
async function uniqueSlug(db: ScopedDb, name: string): Promise<string> {
  const base = slugify(name) || "rules";
  let slug = base;
  for (let n = 2; ; n++) {
    // findFirst, not findUnique: a slug is only unique within a workspace, and the
    // scoped client supplies the workspace half of that key.
    if (!(await db.ruleDocument.findFirst({ where: { slug } }))) return slug;
    slug = `${base}-${n}`;
  }
}

/**
 * The single active rule document, created (and activated) on first use so the
 * feature works from a standing start. Only one document is ever active; the app no
 * longer exposes multiple, but the schema still allows them, so this also demotes
 * any stragglers when it creates one.
 */
export async function activeRuleDocument(db: ScopedDb) {
  const existing = await db.ruleDocument.findFirst({ where: { active: true } });
  if (existing) return existing;

  const doc = await db.ruleDocument.create({
    data: {
      workspaceId: db.$workspaceId,
      name: "Automations",
      slug: await uniqueSlug(db, "Automations"),
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

/** The active document's graph, parsed. */
export async function readRuleGraph(db: ScopedDb): Promise<Graph> {
  const doc = await activeRuleDocument(db);
  return JSON.parse(doc.content) as Graph;
}

/** Load the active graph, hand it to `mutate`, and persist the result. */
export async function editRuleGraph(
  db: ScopedDb,
  mutate: (graph: Graph) => void,
): Promise<void> {
  const doc = await activeRuleDocument(db);
  const graph = JSON.parse(doc.content) as Graph;
  mutate(graph);
  await db.ruleDocument.update({
    where: { id: doc.id },
    data: { content: JSON.stringify(graph) },
  });
}
