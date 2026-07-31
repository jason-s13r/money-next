import { withScopedTx, type ScopedDb } from "../db";
import { proposeBudget } from "./infer";
import { openInferenceLog } from "./inference-log";
import { createInferredBudget, refreshInferred, streamKeyOf } from "./write";

// What the worker does when it claims a queued `BudgetInferenceRun`.
//
// This is the slow part that was moved off the request: `proposeBudget` may spend a
// minute or more talking to the local LLM. No `import "server-only"` — it runs in
// plain Node under scripts/drain.ts — and it takes its scoped db as an argument
// rather than reaching for a request client, because there is no request.
//
// It is also where the run's log begins and ends. The conversation itself is written by
// the inference (./llm.ts); what is only known out here is how the run *ended* — which
// budget it built, or why it failed — so those lines are added here, and the thread's
// claim is released in a `finally` whichever way it went. See ./inference-log.ts.

/**
 * Run one inference: build a new locked budget, or refresh an existing one.
 *
 * `budgetId` null is a create — the budgets page shows the run in flight until the
 * budget it returns appears. `budgetId` set is a re-infer of that budget in place,
 * preserving any rows the user has hand-edited (the `inferred: false` ones), exactly
 * as the old in-request re-infer did.
 *
 * `userId` is who asked, and is needed for nothing but the log: a thread is private to
 * its author, so a run nobody owns is logged to the console alone.
 *
 * Returns the id of the budget built or refreshed, which the caller stores on the
 * run so the UI can point at it. Throws on anything that should retry/fail the run;
 * the drain loop turns that into backoff or a terminal failure with the message.
 */
export async function runBudgetInference(
  db: ScopedDb,
  run: { id: string; budgetId: string | null; userId: string | null },
): Promise<string> {
  const now = new Date();
  const log = await openInferenceLog(db, {
    id: run.id,
    userId: run.userId,
    reinfer: run.budgetId !== null,
    now,
  });

  try {
    const proposal = await proposeBudget(db, now, log);
    if (proposal.items.length === 0) {
      // Two different empties, and telling someone the wrong one sends them looking in
      // the wrong place: a run stopped before it had proposed anything is not a
      // household with no history.
      throw new Error(
        proposal.stopped
          ? "Stopped before anything had been proposed, so there was no budget to build."
          : "There isn't enough categorised transaction history to infer a budget from.",
      );
    }

    if (run.budgetId) {
      const budget = await db.budget.findUnique({
        where: { id: run.budgetId },
        select: {
          id: true,
          name: true,
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
      await log?.note(
        `Refreshed “${budget.name}” with ${proposal.items.length} inferred items` +
          `${kept.size > 0 ? `, keeping ${kept.size} hand-edited one(s)` : ""}.`,
      );
      return budget.id;
    }

    // The model names what it built — it is the only thing here that has seen what
    // went into it (see the `finish` tool). The fallback is for the deterministic
    // path, which knows rows and not what they add up to, and for a model that
    // finished without saying. Either way the household can rename it.
    const name = proposal.name?.trim() || "Household budget";
    const created = await createInferredBudget(db, name, proposal);
    await log?.note(`Created “${name}” with ${proposal.items.length} items.`);
    return created.id;
  } catch (error) {
    // Said in the log before it is re-thrown, so the reason is at the end of the
    // conversation that led to it and not only on the run row. The throw still stands:
    // the drain loop is what decides between a retry and a terminal failure.
    await log?.note(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    // Always: a log left claiming to be working is a log that reads as a run still
    // going, and this one is over either way.
    await log?.close();
  }
}
