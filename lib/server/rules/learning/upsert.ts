import {
  CATEGORY_COL,
  ensureTable,
  LABEL_COL,
  MATCH_COL,
  MERCHANT_COL,
  type Graph,
  type TableRule,
} from "./graph";
import { id } from "./id";
import { type DerivedMatch } from "./match";

export type LearnedOutputs = {
  categoryId?: string | null;
  merchantId?: string | null;
  /** The tag to put on transactions this rule changes, instead of the derived
   *  `category-rule-…`/`merchant-rule-…` one. Stored by name (see labels.ts). */
  labelName?: string | null;
  /** A human label stored on the row (`_description`) for the editor. */
  label?: string;
};

export type UpsertResult = { graph: Graph; merged: boolean };

const TYPE_CLAUSE = /^type == '([^']*)'$/;
const CONTAINS_CLAUSE = /^contains\(lower\(description\), '([^']*)'\)$/;

/** Parse a generated predicate back into type + tokens. */
function parseMatch(expression: string): { type: string | null; tokens: string[]; structured: boolean } {
  const raw = expression.trim();
  if (raw === "" || raw === "false") return { type: null, tokens: [], structured: true };

  let type: string | null = null;
  const tokens: string[] = [];
  for (const clause of raw.split(" and ").map((c) => c.trim())) {
    const t = TYPE_CLAUSE.exec(clause);
    if (t) { type = t[1]; continue; }
    const m = CONTAINS_CLAUSE.exec(clause);
    if (m) { tokens.push(m[1]); continue; }
    return { type: null, tokens: [], structured: false };
  }
  return { type, tokens, structured: true };
}

/** Strip a cell's string-literal quotes to recover the id it outputs, or null. */
function literalId(cell: string | undefined): string | null {
  if (!cell) return null;
  const m = /^'(.*)'$/.exec(cell.trim());
  return m ? m[1] : cell.trim() || null;
}

/**
 * Fold a learned rule into the graph. Three cases, in order:
 *
 *  1. Exact predicate exists → fill missing outputs.
 *  2. A same-type rule with the same outputs is already broader → nothing to add.
 *  3. Otherwise add the new row, removing any narrower rows it subsumes.
 */
export function upsertLearnedRule(
  graph: Graph,
  match: DerivedMatch,
  outputs: LearnedOutputs,
): UpsertResult {
  const table = ensureTable(graph);
  const cat = outputs.categoryId ? `'${outputs.categoryId}'` : "";
  const mer = outputs.merchantId ? `'${outputs.merchantId}'` : "";
  const lab = outputs.labelName ? `'${outputs.labelName}'` : "";

  const existing = table.rules.find((r) => r[MATCH_COL] === match.expression);
  if (existing) {
    if (cat) existing[CATEGORY_COL] = cat;
    if (mer) existing[MERCHANT_COL] = mer;
    if (lab) existing[LABEL_COL] = lab;
    if (outputs.label) existing._description = outputs.label;
    return { graph, merged: true };
  }

  const newTokens = new Set(match.tokens);
  const subset = (a: string[], b: Set<string>) => a.every((t) => b.has(t));
  const sameKind = table.rules.filter((r) => {
    const p = parseMatch(r[MATCH_COL] ?? "");
    return (
      p.structured &&
      p.type === match.type &&
      literalId(r[CATEGORY_COL]) === (outputs.categoryId ?? null) &&
      literalId(r[MERCHANT_COL]) === (outputs.merchantId ?? null) &&
      literalId(r[LABEL_COL]) === (outputs.labelName ?? null)
    );
  });

  for (const r of sameKind) {
    if (subset(parseMatch(r[MATCH_COL] ?? "").tokens, newTokens)) {
      if (outputs.label) r._description = outputs.label;
      return { graph, merged: true };
    }
  }

  const subsumed = new Set(
    sameKind
      .filter((r) => subset(match.tokens, new Set(parseMatch(r[MATCH_COL] ?? "").tokens)))
      .map((r) => r._id),
  );
  if (subsumed.size) table.rules = table.rules.filter((r) => !subsumed.has(r._id));

  // Every output cell is written, empty ones included: a row missing a column's
  // key is skipped by the engine entirely, not merely treated as setting nothing
  // (see `normalizeTable`), which is what made category-only rules never fire.
  const row: TableRule = {
    _id: id("row"),
    [MATCH_COL]: match.expression,
    [CATEGORY_COL]: cat,
    [MERCHANT_COL]: mer,
    [LABEL_COL]: lab,
  };
  if (outputs.label) row._description = outputs.label;
  table.rules.unshift(row);
  return { graph, merged: subsumed.size > 0 };
}
