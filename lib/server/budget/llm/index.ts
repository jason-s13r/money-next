import type { ScopedDb } from "../../db";
import {
  languageModel,
  MAX_STEPS,
  MAX_TOOL_ROWS,
  MODEL,
} from "../../chat/client";
import {
  eagerHistory,
  lazyFx,
  loadCatalog,
  loadHistory,
  type ToolContext,
} from "../../chat/tools";
import { dedupeProposedItems } from "../../../budget/llm";
import type { BudgetProposal } from "../infer";
import { proposeBudgetFromHistoryForWindows } from "../infer";
import type { InferenceLog } from "../inference-log";

export { isLlmAvailable } from "../../chat/client";
export { SYSTEM_PROMPT } from "./prompt";

import { runConversation } from "./conversation";
import { log } from "./log";

/**
 * Read history, let the model work through it, and return the same `BudgetProposal`
 * the deterministic seeder does.
 *
 * `into` is the run's log, when it has one — the conversation is written to it as it
 * happens, so a run that dies halfway leaves everything up to the point it died,
 * which is exactly when a log earns its keep. Null when there is nobody to own the
 * thread, and then this reports itself to the console only.
 *
 * Throws if the endpoint is unset or fails mid-run; callers wrap this in a
 * try/`isLlmAvailable` and fall back to `proposeBudgetFromHistory`, so a model that
 * dies halfway never leaves the button broken.
 */
export async function inferViaLLM(
  db: ScopedDb,
  now: Date = new Date(),
  into: InferenceLog | null = null,
): Promise<BudgetProposal> {
  const model = languageModel();
  if (!model) throw new Error("LLM_API is not configured");

  // Eagerly, unlike a chat: the envelope needs the counts whatever the model does.
  const history = await loadHistory(db, now);
  const { areas, currency, count, monthsOfHistory } = history;
  const envelope = { monthsOfHistory, transactions: count, currency };

  if (count === 0) {
    await into?.note("No categorised transaction history to read. Nothing was proposed.");
    return { items: [], ...envelope };
  }

  const ctx: ToolContext = {
    db,
    now,
    currency,
    catalog: await loadCatalog(db),
    history: eagerHistory(history),
    fx: lazyFx(db),
    can: { budget: false, enrichment: false },
    actorUserId: null,
  };

  const header =
    `Reading ${count.toLocaleString()} transactions over about ${monthsOfHistory} months ` +
    `across ${areas.size} spending areas, in ${currency}. ` +
    `Model ${MODEL}, up to ${MAX_TOOL_ROWS} transactions a read and ${MAX_STEPS} steps.`;
  log(header);
  await into?.note(header);

  const { items: proposed, coveredAreas, name, stopped } = await runConversation({
    model,
    ctx,
    into,
  });

  const missed = [...areas.values()].filter((a) => !coveredAreas.has(a.groupId));
  const all = [...proposed];
  if (missed.length > 0 && stopped) {
    const left = `Not proposed for: ${missed.map((a) => a.name).join(", ")}.`;
    log(left);
    await into?.note(left);
  } else if (missed.length > 0) {
    const gap =
      `${missed.length} area(s) not proposed for (${missed.map((a) => a.name).join(", ")}) — ` +
      `falling back to deterministic detection for those`;
    log(gap);
    await into?.note(gap);
    const fallback = await proposeBudgetFromHistoryForWindows(db, now, missed);
    all.push(...fallback.items);
  }

  const items = dedupeProposedItems(all).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  log(`resolved ${items.length} budget items across ${areas.size} areas`);
  await into?.note(
    `Resolved ${items.length} budget items across ${areas.size} areas:\n` +
      items.map((i) => `  ${i.name} — ${i.amount} ${i.cadence}`).join("\n"),
  );
  return { items, name, stopped, ...envelope };
}
