import {
  CATEGORY_COL,
  LABEL_COL,
  learnedTable,
  MATCH_COL,
  MERCHANT_COL,
  normalizeTable,
  type Graph,
} from "./graph";
import { buildExpression, normalizeToken } from "./match";

// Editing a rule that already exists, rather than teaching a new one.
//
// A derived predicate is a good first guess and a poor last word: the tokeniser
// keeps whatever looked stable, which sometimes includes a reference that only
// ever appears once (`3cb-kensingtonh`), and only a person can tell that apart
// from a name. So the tokens, the type and all three outputs are editable, and
// the row is rewritten in place — its position in the table is its precedence
// under the first-match policy, and editing a rule is not a reason to change it.
//
// No `import "server-only"`, for the reason match.ts gives.

export type RuleEdit = {
  /** The transaction type to gate on, or null for any. */
  type: string | null;
  tokens: string[];
  categoryId: string | null;
  merchantId: string | null;
  /** The tag to apply instead of the derived one, or null for derived. */
  labelName: string | null;
};

export type ValidatedEdit = RuleEdit & { tokens: string[] };

export type EditValidation =
  | { ok: true; edit: ValidatedEdit }
  | { ok: false; reason: string };

/**
 * Check an edit and clean up its tokens, so the action and the editor agree on
 * what a usable rule is without either of them owning the answer.
 *
 * Two things make a rule pointless rather than merely narrow, and both are worth
 * refusing rather than storing: no tokens at all (`type == 'DEBIT'` alone would
 * catch half the ledger), and no category or merchant (a rule that sets only a
 * label has nothing to change, and a label is only applied to transactions a rule
 * changed — see `runRules`).
 */
export function validateEdit(edit: RuleEdit): EditValidation {
  const tokens: string[] = [];
  for (const raw of edit.tokens) {
    const token = normalizeToken(raw);
    if (token === null) return { ok: false, reason: `“${raw.trim()}” isn’t a usable token.` };
    if (!tokens.includes(token)) tokens.push(token);
  }
  if (tokens.length === 0) {
    return { ok: false, reason: "Give the rule at least one word to match on." };
  }
  if (!edit.categoryId && !edit.merchantId) {
    return { ok: false, reason: "A rule has to set a category or a merchant." };
  }
  // The label is written into the table as a quoted literal like the ids beside
  // it, so an apostrophe in the name would break out of it.
  if (edit.labelName?.includes("'")) {
    return { ok: false, reason: "A label name can’t contain an apostrophe." };
  }
  return {
    ok: true,
    edit: {
      type: edit.type || null,
      tokens,
      categoryId: edit.categoryId || null,
      merchantId: edit.merchantId || null,
      labelName: edit.labelName?.trim() || null,
    },
  };
}

/** Rewrite a learned rule in place. False when the graph has no such row. */
export function updateLearnedRule(graph: Graph, ruleId: string, edit: ValidatedEdit): boolean {
  const table = learnedTable(graph);
  if (!table) return false;
  const row = table.rules.find((r) => r._id === ruleId);
  if (!row) return false;

  normalizeTable(table);
  row[MATCH_COL] = buildExpression(edit.type, edit.tokens);
  row[CATEGORY_COL] = edit.categoryId ? `'${edit.categoryId}'` : "";
  row[MERCHANT_COL] = edit.merchantId ? `'${edit.merchantId}'` : "";
  row[LABEL_COL] = edit.labelName ? `'${edit.labelName}'` : "";
  return true;
}
