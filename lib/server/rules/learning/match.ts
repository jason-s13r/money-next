import "server-only";
import { descriptionTokens } from "../../matching/matching";

// Turning one correct, hand-classified transaction into a durable rule: derive a
// match predicate from its stable text (the same tokenisation that powers the
// "similar transactions" list — see `descriptionTokens`).

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

  const clauses = [
    `type == '${tx.type}'`,
    ...tokens.map((t) => `contains(lower(description), '${t}')`),
  ];
  return { expression: clauses.join(" and "), type: tx.type, tokens };
}
