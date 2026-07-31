import { describeRecurrence, isFrequency, type Frequency } from "./recurrence";
import type { ProposedItem } from "../server/budget/infer";

// The pure half of LLM budget inference: parsing what a model returned and
// resolving it to real ids, with no network and no database. It lives here, beside
// the recurrence arithmetic, for the same reason that does — it is where a bug is
// silent (a mis-mapped category, a dropped bill) and so it is what the tests pin.
//
// The server half (lib/server/budget/llm.ts) runs the conversation, answers the
// model's tool calls out of the transaction history, and builds the `Catalog` these
// functions consume. Everything a model says passes through `resolveProposedItems`
// before it is trusted: names in, real ids out, and anything that will not resolve
// or validate dropped.
//
// `ProposedItem` is imported as a type only, so nothing here pulls the server-only
// module it is declared in into a plain test run.

/** A row as the model returns it — every field `unknown`, because it is. */
export type RawBudgetItem = {
  name?: unknown;
  direction?: unknown;
  amount?: unknown;
  frequency?: unknown;
  interval?: unknown;
  anchorDate?: unknown;
  group?: unknown;
  category?: unknown;
  merchant?: unknown;
  basis?: unknown;
};

/** The name→id lookups a proposed row is resolved through. Keys are lower-cased;
 *  categories are keyed by their group id too, so "Groceries" under Food does not
 *  collide with a "Groceries" someone filed elsewhere. */
export type Catalog = {
  groups: Map<string, { id: string; name: string }>;
  categories: Map<string, { id: string; name: string }>;
  merchants: Map<string, { id: string; name: string }>;
};

/** The category-map key: its group id and its lower-cased name. Exported so the
 *  server half builds the map with the same key `resolveProposedItems` reads. */
export const catKey = (groupId: string, name: string) => `${groupId}|${name.toLowerCase()}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pull the item array out of whatever the model wrapped it in. Tolerates a bare
 *  array, `{ items: [...] }`, `{ budget: [...] }` or `{ budgetItems: [...] }`, and
 *  returns `[]` on anything that will not parse rather than throwing — a garbled
 *  reply must not sink the run. Also strips markdown fences the model sometimes
 *  adds despite being asked for raw JSON only.
 *
 *  Items normally arrive as the arguments of a `propose_items` tool call, not as
 *  message text. This is the salvage path for the weaker model that ignores the
 *  tools and just writes the JSON out in its reply: rather than lose the answer,
 *  the text is parsed the old way and resolved through the same gate.
 */
export function parseModelContent(content: string): RawBudgetItem[] {
  const stripped = stripJsonMarkdown(content);
  let value: unknown;
  try {
    value = JSON.parse(stripped);
  } catch {
    return [];
  }
  const array = Array.isArray(value)
    ? value
    : isRecord(value)
      ? ((value.items ?? value.budget ?? value.budgetItems) as unknown)
      : null;
  return Array.isArray(array) ? (array as RawBudgetItem[]) : [];
}

/** Remove ```json / ``` fences and any leading/trailing whitespace. */
function stripJsonMarkdown(content: string): string {
  return content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * A tool call's `arguments` as an object, or null when they will not parse.
 *
 * The wire format is a JSON *string*, and a local model is loose with it: fences
 * around it, or the whole object encoded a second time so the string parses to
 * another string. Both are unwrapped here, and a call whose arguments are beyond
 * saving returns null.
 *
 * The SDK owns the parsing of a tool call now, and is strict about it. This is what
 * still reaches it, through `repairLooseToolCall` — which is where the null goes back
 * to meaning "hand the model its own error" rather than "throw".
 */
export function parseToolArguments(raw: string | undefined | null): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(stripJsonMarkdown(raw));
  } catch {
    return null;
  }
  // Double-encoded: the arguments string held a JSON string holding the object.
  if (typeof value === "string") {
    try {
      value = JSON.parse(stripJsonMarkdown(value));
    } catch {
      return null;
    }
  }
  return isRecord(value) && !Array.isArray(value) ? value : null;
}

/** A `YYYY-MM-DD` at UTC midnight — the NZ-day representation the recurrence module
 *  uses throughout — or null. Same parse as the budget actions'. */
function parseDay(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

/**
 * Turn the model's rows into `ProposedItem`s, dropping everything that does not
 * resolve or validate.
 *
 * The rules are the mirror of the hand editor's (`readItem`), because a proposed
 * row and a typed one become the same `BudgetItem`: a positive magnitude with a
 * direction that sets the sign, a real frequency, an interval in range, and a group
 * that names a real one. A group that does not resolve drops the row — a budgeted
 * amount that belongs to no group cannot appear in the breakdown at all. A category
 * or merchant that does not resolve just degrades to null; the money still belongs
 * to its group.
 */
export function resolveProposedItems(
  raw: RawBudgetItem[],
  catalog: Catalog,
  now: Date,
): ProposedItem[] {
  const fallbackAnchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const items: ProposedItem[] = [];

  raw.forEach((row, index) => {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) return;

    const magnitude = Math.abs(Number(row.amount));
    if (!Number.isFinite(magnitude) || magnitude === 0) return;
    const amount = row.direction === "income" ? magnitude : -magnitude;

    const frequency = typeof row.frequency === "string" ? row.frequency : "";
    if (!isFrequency(frequency)) return;

    const intervalRaw = Number(row.interval);
    const interval =
      Number.isInteger(intervalRaw) && intervalRaw >= 1 && intervalRaw <= 365 ? intervalRaw : 1;

    const groupName = typeof row.group === "string" ? row.group.trim().toLowerCase() : "";
    const group = catalog.groups.get(groupName);
    if (!group) return;

    const categoryName = typeof row.category === "string" ? row.category.trim() : "";
    const category = categoryName
      ? (catalog.categories.get(catKey(group.id, categoryName)) ?? null)
      : null;

    const merchantName = typeof row.merchant === "string" ? row.merchant.trim().toLowerCase() : "";
    const merchant = merchantName ? (catalog.merchants.get(merchantName) ?? null) : null;

    const anchorDate = parseDay(row.anchorDate) ?? fallbackAnchor;
    const freq = frequency as Frequency;

    items.push({
      key: `${group.id}|${category?.id ?? ""}|${merchant?.id ?? ""}|${index}`,
      name,
      amount,
      frequency: freq,
      interval,
      anchorDate,
      groupId: group.id,
      groupName: group.name,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      merchantId: merchant?.id ?? null,
      merchantName: merchant?.name ?? null,
      basis:
        typeof row.basis === "string" && row.basis.trim() ? row.basis.trim() : "inferred by model",
      cadence: describeRecurrence({ frequency: freq, interval, anchorDate }),
      // Every model-proposed row is a named commitment. The deterministic path's
      // "Other {group}" remainders have no equivalent here on purpose: the model is
      // asked to name spending, which is the whole reason to prefer it.
      kind: "recurring",
      // These rows are the model's; the deterministic detector's are `computed`.
      source: "ai",
    });
  });

  return items;
}

/**
 * Collapse genuine repeats a model left in its output, keeping the largest of each.
 *
 * Even batched a group at a time, a weak model will sometimes list the same
 * commitment twice — two "Woolworths" lines where there is one weekly shop. This is
 * the safety net for that: only the largest of a set of repeats survives (never
 * summed — that would double the very figure being de-duplicated).
 *
 * The identity is group + payee + name, deliberately *not* group + payee alone. One
 * payee routinely covers several distinct commitments — Skinny is a household's
 * broadband *and* two separate mobile lines — and collapsing on the merchant would
 * silently throw two of the three away. So a repeat is only a repeat when the model
 * gave it the same name; distinct names under one payee are kept. Naming those apart
 * is the model's job, which is why it is handed the description and card suffix that
 * tell the lines apart.
 */
export function dedupeProposedItems(items: ProposedItem[]): ProposedItem[] {
  const best = new Map<string, ProposedItem>();
  for (const item of items) {
    const key = `${item.groupId}|${item.merchantId ?? ""}|${item.name.trim().toLowerCase()}`;
    const current = best.get(key);
    if (!current || Math.abs(item.amount) > Math.abs(current.amount)) best.set(key, item);
  }
  return [...best.values()];
}
