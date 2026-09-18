import { distinctiveTokens } from "./rules/learning/match";

// Which pending holds a workspace has asked not to see, and how a rule for one is
// derived from a row. Pure string and set work — the query layer loads the rules
// and the table renders them, and both need the same idea of what "matches"
// means, so it lives here rather than in either.
//
// Deliberately *not* the rules engine. That one evaluates a ZEN decision graph
// over settled transactions and writes categories, merchants and labels through
// the field-change log; pending rows carry none of what it reads (no merchant, no
// category — Akahu attaches only `meta`) and none of what it writes. What is
// shared is the vocabulary: a bank, plus description tokens that must all appear,
// derived by the same `distinctiveTokens` a learned rule's predicate is built
// from. So a dismissal reads like a rule on /rules without being one.

/** A stored dismissal, as the matcher needs it. */
export type DismissalRule = {
  id: string;
  connectionId: string;
  tokens: string[];
};

/** A pending row, as the matcher needs it. */
export type DismissablePending = {
  connectionId: string;
  description: string;
};

/**
 * Whether one rule captures one hold: same bank, and every token present in the
 * description.
 *
 * A rule with no tokens matches nothing rather than everything. It cannot be
 * written (`dismissalTokens` returning empty is what stops the action), but the
 * failure mode if one ever existed is a whole bank's holds silently vanishing, so
 * the matcher refuses it too rather than trusting the writer.
 */
export function matchesDismissal(rule: DismissalRule, tx: DismissablePending): boolean {
  if (rule.tokens.length === 0) return false;
  if (rule.connectionId !== tx.connectionId) return false;
  const description = tx.description.toLowerCase();
  return rule.tokens.every((token) => description.includes(token));
}

/** The first rule hiding this hold, or null when none does. */
export function dismissalFor<R extends DismissalRule>(
  tx: DismissablePending,
  rules: readonly R[],
): R | null {
  return rules.find((rule) => matchesDismissal(rule, tx)) ?? null;
}

/**
 * The tokens a dismissal derived from this row should require.
 *
 * `distinctiveTokens` first, so the rule keys on the identifying words and
 * survives the parts that drift — the receipt number in `#759255 MCDONALDS BANK
 * STREET` is exactly what would make a rule match once and never again.
 *
 * When it finds nothing distinctive (an all-numeric description), the whole
 * description stands in as a single token rather than the rule falling back to
 * the bank alone. Narrow and literal is the right failure here: the person asked
 * to hide *this*, and a bank-wide rule would hide things they never saw.
 */
export function dismissalTokens(description: string): string[] {
  const derived = distinctiveTokens(description);
  if (derived.length > 0) return derived;
  const whole = description.trim().toLowerCase();
  return whole === "" ? [] : [whole];
}
