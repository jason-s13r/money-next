// The tokenisation the whole matching layer is built on, on its own so that the
// callers who only need *this* do not have to load the ones that need a request.
//
// No `import "server-only"`: matching.ts carries it and must — its functions reach
// for the ambient request client — but tokenisation is a pure string operation, and
// two things outside a request now want it. `lib/server/rules/learning/match.ts`
// derives a rule predicate from it, and the chat's rules tools reach that from a
// detached turn (and share a module graph with the worker's budget inference, where
// `server-only` throws on load). Splitting the pure half out is what lets both hold
// the same idea of what a token is, rather than a second copy that drifts.

// A description is split into comparable tokens on whitespace and `#`, with
// leading/trailing punctuation trimmed but internal punctuation kept — so a
// counterparty's dashed account number (a stable signal) survives intact while a
// `#`-glued reference like `<ref>#<name>` separates into its volatile and stable
// halves.
export function descriptionTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s#]+/)
      .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
      // Drop tokens carrying an unbroken run of 4+ digits: a per-transaction
      // reference or batch id (`payrollref778213004411`, `d783879600`) that changes
      // every instance, so it only ever lowers the overlap between two instances of
      // the same recurring payment. A dashed account number like `012-345-678` — a
      // *stable* shared signal — has only 3-digit groups and survives.
      .filter((t) => t !== "" && !/\d{4,}/.test(t)),
  );
}

/** Jaccard overlap of two token sets: shared tokens over their union, in [0, 1]. */
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// How much description overlap counts as "similar". With volatile reference/batch
// numbers dropped at tokenisation above, two instances of the same recurring
// credit that differ only in that reference score at or near 1.0; unrelated direct
// credits sharing just "direct"/"credit" score well under this.
export const SIMILAR_THRESHOLD = 0.5;

/**
 * The smallest set of a description's tokens that a transaction scoring above
 * `SIMILAR_THRESHOLD` against it is *guaranteed* to contain at least one of — so a
 * caller can push the search into SQL and throw away the rest of the ledger before
 * scoring any of it.
 *
 * The bound is exact, not a heuristic. Write `s` for the shared tokens, `a` and
 * `b` for the two set sizes. Passing the threshold means `s / (a + b - s) ≥ 1/2`,
 * i.e. `3s ≥ a + b`; and `b ≥ s` always, so `3s ≥ a + s`, giving **`s ≥ a/2`**: a
 * similar transaction shares at least half of this one's tokens. By pigeonhole,
 * any subset of more than half of them must then contain one of the shared ones —
 * so `⌊a/2⌋ + 1` tokens is enough, and nothing that would have scored above the
 * threshold can be filtered out by asking for them.
 *
 * Longest first because the prefilter runs against the `gin_trgm_ops` index on
 * `description` (see the schema), and a token shorter than three characters has
 * no trigram to look up — it would fall back to a scan and take the whole `OR`
 * with it. Length is the only selectivity signal available without statistics,
 * and it happens to be the one the index cares about. When there are not enough
 * long tokens the short ones are used anyway: losing the guarantee would change
 * the answer, and being slow is only slow.
 *
 * Here rather than beside its caller because it is the same kind of thing as the
 * rest of this file — a pure fact about tokens — and because the guarantee it
 * makes is one worth holding to a test, which `server-only` would prevent.
 */
export function prefilterTokens(tokens: Set<string>): string[] {
  const longestFirst = [...tokens].toSorted((a, b) => b.length - a.length);
  return longestFirst.slice(0, Math.floor(longestFirst.length / 2) + 1);
}
