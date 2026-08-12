import { descriptionTokens } from "../../matching/tokens";

// Turning one correct, hand-classified transaction into a durable rule: derive a
// match predicate from its stable text (the same tokenisation that powers the
// "similar transactions" list — see `descriptionTokens`).
//
// No `import "server-only"`: the chat's rules tools derive predicates too, and they
// sit in a module graph the worker's budget inference loads, where `server-only`
// throws. Nothing here touches a request — it is string work on a description — so
// the guard was never doing anything but marking the file's neighbourhood. The
// tokeniser moved to matching/tokens.ts for the same reason.

// Common banking boilerplate that carries no identity — stripped so the predicate
// keys on the distinctive part of a description ("countdown", "i.r.d") rather than
// on "direct"/"payment", which would match half the ledger.
const STOPWORDS = new Set([
  "direct", "credit", "debit", "payment", "payments", "transfer", "transfers",
  "eftpos", "pos", "visa", "mastercard", "purchase", "purchases", "card",
  "online", "ref", "reference", "the", "and", "to", "from", "via", "dc", "ap", "bp",
]);

/**
 * A token is distinctive when it identifies *who/what*, not *how* the money moved.
 * Drops stopwords, and anything ≥60% digits — dates (`31/03/2027`), batch ids
 * (`d783879600`) and account numbers (`012-345-678`) all drift or over-narrow, so
 * they make poor rule keys even though they survive tokenisation.
 */
function isDistinctive(token: string): boolean {
  if (token.length < 2) return false;
  if (STOPWORDS.has(token)) return false;
  if (token.includes("'")) return false; // keep generated expressions quote-safe
  // Volatile reference/batch numbers (an unbroken 4+ digit run, even when letters
  // pad it — `payrollref778213004411`) are already stripped by `descriptionTokens`.
  // Here we additionally drop *mostly*-numeric tokens like the dashed account
  // number `012-345-678`: a fine similarity signal, but too narrow to key a rule
  // on when stable words (`i.r.d`, `fam`) are present to carry it.
  const digits = (token.match(/\d/g) ?? []).length;
  return digits / token.length < 0.6;
}

/** The distinctive tokens of a description, longest first (most identifying), up
 *  to `limit`. Longest-first because a longer token is rarer and safer to key on. */
export function distinctiveTokens(description: string, limit = 4): string[] {
  return [...descriptionTokens(description)]
    .filter(isDistinctive)
    .toSorted((a, b) => b.length - a.length)
    .slice(0, limit);
}

/**
 * A token as a rule can store it: trimmed, lowercased (the predicate compares
 * against `lower(description)`), and free of the single quote that would break
 * out of the generated string literal. Null when nothing usable is left.
 *
 * The gate a hand-edited token passes, where `isDistinctive` is the gate a
 * *derived* one passes — a person tidying `3cb-kensingtonh` down to `kensington`
 * knows things the stopword list does not, so this only enforces what the
 * expression format itself requires.
 */
export function normalizeToken(raw: string): string | null {
  const token = raw.trim().toLowerCase();
  if (token === "" || token.includes("'")) return null;
  return token;
}

/**
 * The ZEN predicate for a type and a set of tokens: every token must appear in
 * the description, and the transaction must be of that type when one is given.
 * A null type matches any (`parseMatch` reads one back the same way).
 */
export function buildExpression(type: string | null, tokens: string[]): string {
  return [
    ...(type ? [`type == '${type}'`] : []),
    ...tokens.map((t) => `contains(lower(description), '${t}')`),
  ].join(" and ");
}

export type DerivedMatch = {
  /** A ZEN boolean expression over the transaction input. */
  expression: string;
  /** The transaction `type` the predicate is gated on. */
  type: string;
  /** The distinctive tokens the expression requires, for display. */
  tokens: string[];
};

/**
 * Derive a match predicate from a transaction: its `type`, plus a `contains` test
 * per distinctive description token (all required — AND). Returns null when no
 * distinctive token can be found (an all-numeric description), since a rule on
 * `type` alone would be far too broad to apply safely.
 */
export function deriveMatch(tx: { type: string; description: string }): DerivedMatch | null {
  const tokens = distinctiveTokens(tx.description);
  if (tokens.length === 0) return null;

  return { expression: buildExpression(tx.type, tokens), type: tx.type, tokens };
}
