import {
  parseModelContent,
  resolveProposedItems,
  type Catalog,
  type RawBudgetItem,
} from "../../../budget/llm";
import type { Area } from "../../chat/tools";
import type { ProposedItem } from "../infer";

/** Resolve a proposed batch against the real catalog, and answer with what happened
 *  to each row — the feedback that lets the model correct itself in the next turn. */
export function proposeItems(
  args: Record<string, unknown>,
  byName: Map<string, Area>,
  catalog: Catalog,
  now: Date,
  callIndex: number,
): { result: unknown; area: Area | null; accepted: ProposedItem[]; rejected: string[] } {
  const name = typeof args.area === "string" ? args.area.trim() : "";
  const area = byName.get(name.toLowerCase());
  if (!area) {
    return {
      area: null,
      accepted: [],
      rejected: [],
      result: {
        error: `No spending area called "${name}". Items must be proposed against a real area.`,
        areas: [...byName.values()].map((a) => a.name),
      },
    };
  }

  const raw = Array.isArray(args.items) ? (args.items as RawBudgetItem[]) : [];
  if (raw.length === 0) {
    return {
      area,
      accepted: [],
      rejected: [],
      result: { error: "No items in the call. Send an items array, or call finish." },
    };
  }

  const accepted: ProposedItem[] = [];
  const rejected: string[] = [];
  raw.forEach((item, index) => {
    const [resolved] = resolveProposedItems([{ ...item, group: area.name }], catalog, now);
    if (resolved) {
      accepted.push({ ...resolved, key: `${resolved.key}|${callIndex}.${index}` });
    } else {
      const label = typeof item.name === "string" && item.name.trim() ? item.name : "(unnamed)";
      rejected.push(`${label}: ${whyRejected(item)}`);
    }
  });

  const categories = distinct(area.txns.map((t) => t.category));
  return {
    area,
    accepted,
    rejected,
    result: {
      area: area.name,
      accepted: accepted.length,
      rejected,
      ...(rejected.length > 0 ? { allowedCategories: categories } : {}),
      note:
        accepted.length > 0
          ? `Recorded. This area's transactions are now dropped from the conversation; move on to the next area.`
          : `Nothing was recorded for this area.`,
    },
  };
}

/** Why a proposed row did not survive `resolveProposedItems`, in the words the model
 *  needs to fix it. Mirrors that function's tests in order. */
export function whyRejected(row: RawBudgetItem): string {
  if (typeof row.name !== "string" || !row.name.trim()) return "no name";
  const magnitude = Math.abs(Number(row.amount));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return "amount must be a non-zero number";
  }
  if (typeof row.frequency !== "string") return "frequency is required";
  if (!["once", "day", "week", "month", "quarter", "year"].includes(row.frequency)) {
    return `frequency "${row.frequency}" is not one of once|day|week|month|quarter|year`;
  }
  return "could not be resolved";
}

/** Items a model wrote out as message text instead of calling `propose_items`. The
 *  group has to come from the model here, so a row that names no real one drops —
 *  which is the same gate every other row goes through. */
export function salvageFromText(
  content: string | null | undefined,
  catalog: Catalog,
  now: Date,
  callIndex: number,
): ProposedItem[] {
  if (!content || !content.trim()) return [];
  const raw = parseModelContent(content);
  if (raw.length === 0) return [];
  return resolveProposedItems(raw, catalog, now).map((item) => ({
    ...item,
    key: `${item.key}|text${callIndex}`,
  }));
}

/** The distinct non-null values, order-stable. */
function distinct(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) if (value) seen.add(value);
  return [...seen];
}
