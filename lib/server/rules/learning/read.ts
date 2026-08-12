import {
  CATEGORY_COL,
  LABEL_COL,
  learnedTable,
  MATCH_COL,
  MERCHANT_COL,
  type Graph,
} from "./graph";

const TYPE_CLAUSE = /^type == '([^']*)'$/;
const CONTAINS_CLAUSE = /^contains\(lower\(description\), '([^']*)'\)$/;

export type ParsedMatch = {
  type: string | null;
  tokens: string[];
  /** False for a hand-written predicate we can't render as chips (shown raw). */
  structured: boolean;
  raw: string;
};

export function parseMatch(expression: string): ParsedMatch {
  const raw = expression.trim();
  if (raw === "" || raw === "false") return { type: null, tokens: [], structured: true, raw };

  let type: string | null = null;
  const tokens: string[] = [];
  for (const clause of raw.split(" and ").map((c) => c.trim())) {
    const t = TYPE_CLAUSE.exec(clause);
    if (t) { type = t[1]; continue; }
    const m = CONTAINS_CLAUSE.exec(clause);
    if (m) { tokens.push(m[1]); continue; }
    return { type: null, tokens: [], structured: false, raw };
  }
  return { type, tokens, structured: true, raw };
}

export type LearnedRuleView = {
  id: string;
  match: ParsedMatch;
  categoryId: string | null;
  merchantId: string | null;
  /** The tag this rule applies instead of the derived one, or null for derived. */
  labelName: string | null;
};

/**
 * Whether `match` captures a transaction — the same test the engine applies,
 * evaluated in JS so the transaction page can show which rules act on a row
 * without a round-trip.
 */
export function matchesTransaction(
  match: ParsedMatch,
  tx: { type: string; description: string },
): boolean {
  if (!match.structured) return false;
  if (!match.type && match.tokens.length === 0) return false;
  if (match.type && match.type !== tx.type) return false;
  const description = tx.description.toLowerCase();
  return match.tokens.every((token) => description.includes(token));
}

/** Strip a cell's string-literal quotes to recover the id it outputs, or null. */
function literalId(cell: string | undefined): string | null {
  if (!cell) return null;
  const m = /^'(.*)'$/.exec(cell.trim());
  return m ? m[1] : cell.trim() || null;
}

/** The learned rules in evaluation order (first-match wins), for display. */
export function readLearnedRules(graph: Graph): LearnedRuleView[] {
  const table = learnedTable(graph);
  if (!table) return [];
  return table.rules.map((r) => ({
    id: r._id,
    match: parseMatch(r[MATCH_COL] ?? ""),
    categoryId: literalId(r[CATEGORY_COL]),
    merchantId: literalId(r[MERCHANT_COL]),
    labelName: literalId(r[LABEL_COL]),
  }));
}

/** Remove a learned rule by its row id. */
export function deleteLearnedRule(graph: Graph, ruleId: string): void {
  const table = learnedTable(graph);
  if (table) table.rules = table.rules.filter((r) => r._id !== ruleId);
}
