import { withScopedTx, type ScopedDb } from "../db";
import { proposeBudget } from "./infer";
import { createInferredBudget, refreshInferred, streamKeyOf } from "./write";

// What the worker does when it claims a queued `BudgetInferenceRun`.
//
// This is the slow part that was moved off the request: `proposeBudget` may spend a
// minute or more talking to the local LLM. No `import "server-only"` — it runs in
// plain Node under scripts/drain.ts — and it takes its scoped db as an argument
// rather than reaching for a request client, because there is no request.

/**
 * Run one inference: build a new locked budget, or refresh an existing one.
 *
 * `budgetId` null is a create — the budgets page shows the run in flight until the
 * budget it returns appears. `budgetId` set is a re-infer of that budget in place,
 * preserving any rows the user has hand-edited (the `inferred: false` ones), exactly
 * as the old in-request re-infer did.
 *
 * Returns the id of the budget built or refreshed, which the caller stores on the
 * run so the UI can point at it. Throws on anything that should retry/fail the run;
 * the drain loop turns that into backoff or a terminal failure with the message.
 */
export async function runBudgetInference(
  db: ScopedDb,
  run: { budgetId: string | null },
): Promise<string> {
  const proposal = await proposeBudget(db);
  if (proposal.items.length === 0) {
    throw new Error("There isn't enough categorised transaction history to infer a budget from.");
  }

  if (run.budgetId) {
    const budget = await db.budget.findUnique({
      where: { id: run.budgetId },
      select: {
        id: true,
        items: {
          where: { inferred: false },
          select: { categoryGroupId: true, categoryId: true, merchantId: true },
        },
      },
    });
    if (!budget) throw new Error("The budget to re-infer no longer exists.");

    const kept = new Set(budget.items.map(streamKeyOf));
    await withScopedTx(db, (tx) =>
      refreshInferred(tx, db.$workspaceId, budget.id, proposal.items, proposal.currency, kept),
    );
    return budget.id;
  }

  const created = await createInferredBudget(db, "Default Budget", proposal);
  return created.id;
}
