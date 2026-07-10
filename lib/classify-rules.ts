import type { Rules } from "./classify";

// Rules are personal — they name your employer, your banks, and you — so they
// live in the gitignored database, not in the source tree. This module is the
// boundary: it turns stored rows into the compiled `Rules` the pure classifier
// takes, and validates the JSON seed format on the way in.

export type RuleRow = {
  id?: number;
  kind: string;
  pattern: string;
  incomeCategory: string | null;
  priority: number;
  enabled: boolean;
};

export type RawRules = {
  internalDescriptions?: string[];
  refundDescriptions?: string[];
  incomeRules?: { pattern: string; category: string }[];
};

/** Patterns are stored as strings and are always matched case-insensitively. */
export function compilePattern(pattern: string, field: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(
      `${field}: invalid regular expression ${JSON.stringify(pattern)} — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Compile enabled rows into the classifier's `Rules`. Ordering is explicit:
 * income rules are first-match-wins, so `priority` decides which payer pattern
 * gets to claim a description before a broader one does.
 */
export function compileRules(rows: RuleRow[]): Rules {
  const enabled = [...rows]
    .filter((row) => row.enabled)
    // Ties break on insertion order, never on whatever the database felt like
    // returning. Two rules at the same priority must not swap places between runs
    // and silently relabel a category.
    .sort((a, b) => a.priority - b.priority || (a.id ?? 0) - (b.id ?? 0));

  return {
    internalDescriptions: enabled
      .filter((row) => row.kind === "internal")
      .map((row) => compilePattern(row.pattern, `rule(internal)`)),
    refundDescriptions: enabled
      .filter((row) => row.kind === "refund")
      .map((row) => compilePattern(row.pattern, `rule(refund)`)),
    incomeRules: enabled
      .filter((row) => row.kind === "income")
      .map((row) => ({
        pattern: compilePattern(row.pattern, `rule(income)`),
        // An income rule without a category would silently produce
        // `incomeCategory: null` rows that look like a classifier bug.
        category: row.incomeCategory ?? "Other income",
      })),
  };
}

/**
 * Validate a JSON seed file and flatten it to rows. Every pattern is compiled
 * here so a typo fails at import time, not halfway through a classification run
 * that has already rewritten part of the table.
 */
export function parseRawRules(raw: RawRules): RuleRow[] {
  const rows: RuleRow[] = [];

  (raw.internalDescriptions ?? []).forEach((pattern, i) => {
    compilePattern(pattern, `internalDescriptions[${i}]`);
    rows.push({ kind: "internal", pattern, incomeCategory: null, priority: i, enabled: true });
  });

  (raw.refundDescriptions ?? []).forEach((pattern, i) => {
    compilePattern(pattern, `refundDescriptions[${i}]`);
    rows.push({ kind: "refund", pattern, incomeCategory: null, priority: i, enabled: true });
  });

  (raw.incomeRules ?? []).forEach((rule, i) => {
    compilePattern(rule.pattern, `incomeRules[${i}].pattern`);
    if (!rule.category) throw new Error(`incomeRules[${i}]: missing "category"`);
    rows.push({
      kind: "income",
      pattern: rule.pattern,
      incomeCategory: rule.category,
      // Preserve file order: income rules are first-match-wins.
      priority: i,
      enabled: true,
    });
  });

  return rows;
}
