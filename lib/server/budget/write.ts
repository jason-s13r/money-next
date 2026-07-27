import { withScopedTx, type ScopedDb, type ScopedTx } from "../db";
import { slugify } from "../../slug";
import type { BudgetProposal, ProposedItem } from "./infer";

// Turning a proposal into budget rows — the writes shared by the worker (which
// creates or refreshes an inferred budget from a queued run) and, historically, the
// re-infer action. No `import "server-only"`: the worker runs this in plain Node.

/** A proposed item as a `BudgetItem` row. Every id here came out of this
 *  workspace's own transactions, so there is nothing to re-validate. */
export function itemRow(
  item: ProposedItem,
  workspaceId: string,
  budgetId: string,
  currency: string,
) {
  return {
    workspaceId,
    budgetId,
    name: item.name,
    amount: item.amount,
    currency,
    categoryGroupId: item.groupId,
    categoryId: item.categoryId,
    merchantId: item.merchantId,
    frequency: item.frequency,
    interval: item.interval,
    anchorDate: item.anchorDate,
    // Nobody has confirmed these figures, so they stay open to being refreshed and
    // are marked as guesses in the UI.
    inferred: true,
    // Provenance for the badge, and the seeder's rationale behind it for the badge's
    // popover — where the figure came from and why.
    inferredSource: item.source,
    basis: item.basis,
  };
}

/** The identity `infer.ts` groups a stream by: group, category, merchant. Used to
 *  tell a proposed row from one the user has already taken over. */
export const streamKeyOf = (row: {
  categoryGroupId?: string;
  groupId?: string;
  categoryId: string | null;
  merchantId: string | null;
}) => `${row.categoryGroupId ?? row.groupId}|${row.categoryId ?? ""}|${row.merchantId ?? ""}`;

/**
 * Replace a budget's still-inferred rows with a fresh proposal.
 *
 * Rows the user has edited (`inferred: false`) survive untouched — that is the
 * whole job of the flag. A proposed row describing a stream one of those already
 * covers is dropped rather than added, because re-adding it would leave the budget
 * counting that commitment twice.
 */
export async function refreshInferred(
  tx: ScopedTx,
  workspaceId: string,
  budgetId: string,
  items: ProposedItem[],
  currency: string,
  kept: Set<string>,
) {
  await tx.budgetItem.deleteMany({ where: { budgetId, inferred: true } });
  const fresh = items.filter((item) => !kept.has(streamKeyOf(item)));
  await tx.budgetItem.createMany({
    data: fresh.map((item) => itemRow(item, workspaceId, budgetId, currency)),
  });
}

/** A budget slug unique within the workspace, `-2`/`-3`… appended on collision.
 *  Takes the db so it works in the worker as well as a request. */
export async function uniqueBudgetSlug(db: ScopedDb, name: string): Promise<string> {
  const base = slugify(name) || "budget";
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    // findFirst, not findUnique: a slug is unique only within a workspace, and the
    // scoped client supplies the other half of that key.
    const clash = await db.budget.findFirst({ where: { slug }, select: { id: true } });
    if (!clash) return slug;
  }
}

/**
 * Create a new inferred (locked) budget from a proposal, items and all, in one
 * transaction so it is never left half-seeded.
 */
export async function createInferredBudget(
  db: ScopedDb,
  name: string,
  proposal: BudgetProposal,
): Promise<{ id: string; slug: string }> {
  const slug = await uniqueBudgetSlug(db, name);
  const workspaceId = db.$workspaceId;
  return withScopedTx(db, async (tx) => {
    const budget = await tx.budget.create({
      data: { workspaceId, name, slug, origin: "inferred" },
    });
    await tx.budgetItem.createMany({
      data: proposal.items.map((item) => itemRow(item, workspaceId, budget.id, proposal.currency)),
    });
    return { id: budget.id, slug };
  });
}
