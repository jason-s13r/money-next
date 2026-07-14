import "server-only";
import { descriptionTokens } from "./matching";

// Turning one correct, hand-classified transaction into a durable rule: derive a
// match predicate from its stable text (the same tokenisation that powers the
// "similar transactions" list — see `descriptionTokens`), then fold it into the
// active decision graph as a row in a "Learned rules" decision table. From then on
// every synced transaction is evaluated against it (lib/server/rules.ts), so the
// category/merchant the user set by hand is applied to future matches on its own.

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
    .sort((a, b) => b.length - a.length)
    .slice(0, limit);
}

export type DerivedMatch = {
  /** A ZEN boolean expression over the transaction input (lib/server/rules.ts). */
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

// --- Decision-table surgery -------------------------------------------------
//
// The learned rules live in one decision table node (`LEARNED_TABLE_ID`) wired
// input → table → output, sitting alongside whatever else the graph does (the
// transfer expression, say) and merging into the same output. Cells are ZEN
// expressions: an input cell is the boolean predicate; an output cell is a string
// literal like `'nzfcc_…'`, or `""` for "leave this field alone".

export const LEARNED_TABLE_ID = "learned-rules";
const MATCH_COL = "when";
const CATEGORY_COL = "out-category";
const MERCHANT_COL = "out-merchant";

type Node = { id: string; type?: string; content?: unknown; [k: string]: unknown };
type Edge = { id: string; sourceId: string; targetId: string; type?: string };
export type Graph = { nodes: Node[]; edges: Edge[] };

type TableRule = Record<string, string>;
type TableContent = {
  hitPolicy: string;
  inputs: { id: string; name: string; field?: string }[];
  outputs: { id: string; name: string; field: string }[];
  rules: TableRule[];
};

function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function findByType(graph: Graph, type: string): Node | undefined {
  return graph.nodes.find((n) => n.type === type);
}

/** Ensure the graph has the learned-rules table, wired input → table → output.
 *  Returns the table node's content, mutated in place by the caller. */
function ensureTable(graph: Graph): TableContent {
  let node = graph.nodes.find((n) => n.id === LEARNED_TABLE_ID);
  if (!node) {
    const content: TableContent = {
      hitPolicy: "first",
      inputs: [{ id: MATCH_COL, name: "When" }],
      outputs: [
        { id: CATEGORY_COL, name: "Category", field: "categoryId" },
        { id: MERCHANT_COL, name: "Merchant", field: "merchantId" },
      ],
      rules: [],
    };
    node = {
      id: LEARNED_TABLE_ID,
      type: "decisionTableNode",
      name: "Learned rules",
      position: { x: 380, y: 340 },
      content,
    };
    graph.nodes.push(node);

    // Wire it in parallel with the rest of the graph so its outputs merge at the
    // output node (confirmed to combine, not replace).
    const input = findByType(graph, "inputNode");
    const output = findByType(graph, "outputNode");
    if (input && !graph.edges.some((e) => e.sourceId === input.id && e.targetId === LEARNED_TABLE_ID)) {
      graph.edges.push({ id: id("edge"), type: "edge", sourceId: input.id, targetId: LEARNED_TABLE_ID });
    }
    if (output && !graph.edges.some((e) => e.sourceId === LEARNED_TABLE_ID && e.targetId === output.id)) {
      graph.edges.push({ id: id("edge"), type: "edge", sourceId: LEARNED_TABLE_ID, targetId: output.id });
    }
  }
  return node.content as TableContent;
}

export type LearnedOutputs = {
  categoryId?: string | null;
  merchantId?: string | null;
  /** A human label stored on the row (`_description`) for the editor. */
  label?: string;
};

export type UpsertResult = { graph: Graph; merged: boolean };

/**
 * Fold a learned rule into the graph. Three cases, in order:
 *
 *  1. A row with the *exact* predicate exists → fill in any output it's missing
 *     (learning category then merchant from the same payer updates one row).
 *  2. A same-type row with the *same outputs* is already broader — its tokens are
 *     a subset of the new ones, so it matches every transaction the new rule would
 *     — → nothing to add; the broad rule already covers this.
 *  3. Otherwise add the new row, first removing any same-type, same-output rows it
 *     now *subsumes* (their tokens are a superset of the new, narrower set).
 *
 * Cases 2–3 are what stop recurring payments with a volatile reference (a benefit
 * that reads `… PAYROLLREF778213004411 W&I Benefit` one fortnight and a different
 * number the next) from minting a near-duplicate rule each time: whichever example
 * yields the fewest stable tokens wins and absorbs the rest.
 */
export function upsertLearnedRule(
  graph: Graph,
  match: DerivedMatch,
  outputs: LearnedOutputs,
): UpsertResult {
  const table = ensureTable(graph);
  const cat = outputs.categoryId ? `'${outputs.categoryId}'` : "";
  const mer = outputs.merchantId ? `'${outputs.merchantId}'` : "";

  // 1. Exact predicate already present.
  const existing = table.rules.find((r) => r[MATCH_COL] === match.expression);
  if (existing) {
    if (cat) existing[CATEGORY_COL] = cat;
    if (mer) existing[MERCHANT_COL] = mer;
    if (outputs.label) existing._description = outputs.label;
    return { graph, merged: true };
  }

  // Same-type rules producing the identical outputs — the only ones it's safe to
  // fold together, since subsumption changes *which* transactions match but must
  // not change what they'd be set to.
  const newTokens = new Set(match.tokens);
  const subset = (a: string[], b: Set<string>) => a.every((t) => b.has(t));
  const sameKind = table.rules.filter((r) => {
    const p = parseMatch(r[MATCH_COL] ?? "");
    return (
      p.structured &&
      p.type === match.type &&
      literalId(r[CATEGORY_COL]) === (outputs.categoryId ?? null) &&
      literalId(r[MERCHANT_COL]) === (outputs.merchantId ?? null)
    );
  });

  // 2. An existing rule is already broader (its tokens ⊆ the new ones).
  for (const r of sameKind) {
    if (subset(parseMatch(r[MATCH_COL] ?? "").tokens, newTokens)) {
      if (outputs.label) r._description = outputs.label;
      return { graph, merged: true };
    }
  }

  // 3. Drop any narrower rules the new one subsumes (new tokens ⊆ theirs), then add.
  const subsumed = new Set(
    sameKind
      .filter((r) => subset(match.tokens, new Set(parseMatch(r[MATCH_COL] ?? "").tokens)))
      .map((r) => r._id),
  );
  if (subsumed.size) table.rules = table.rules.filter((r) => !subsumed.has(r._id));

  const row: TableRule = { _id: id("row"), [MATCH_COL]: match.expression };
  if (cat) row[CATEGORY_COL] = cat;
  if (mer) row[MERCHANT_COL] = mer;
  if (outputs.label) row._description = outputs.label;
  // New, more-specific rules go on top: `first` hit policy means earlier rows win.
  table.rules.unshift(row);
  return { graph, merged: subsumed.size > 0 };
}

// --- Reading the graph back for the native /rules UI -------------------------
//
// The `/rules` page presents the learned table as a plain list, so it needs the
// inverse of the writers above: pull the rows out as structured values, and read
// the transfer toggle off the expression node. Generated predicates always have
// the shape `type == '…' and contains(lower(description), '…') and …`, so they
// parse back into a type + token list for display as chips.

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
  // `false` is the sentinel for an unconfigured rule (never matches); treat it,
  // and a genuinely empty cell, as an empty structured match.
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
};

/**
 * Whether `match` captures a transaction — the same test the engine applies,
 * evaluated in JS so the transaction page can show which rules act on a row
 * without a round-trip. Case-insensitive `contains`, all tokens required, gated
 * on `type`. A match with no condition (the never-configured `false` sentinel)
 * captures nothing; a hand-written predicate we can't parse is treated as a
 * non-match here (its real evaluation still happens in the engine).
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

function learnedTable(graph: Graph): TableContent | null {
  const node = graph.nodes.find((n) => n.id === LEARNED_TABLE_ID);
  return node ? (node.content as TableContent) : null;
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
  }));
}

/** Remove a learned rule by its row id. */
export function deleteLearnedRule(graph: Graph, ruleId: string): void {
  const table = learnedTable(graph);
  if (table) table.rules = table.rules.filter((r) => r._id !== ruleId);
}

// The transfer auto-link toggle lives on the expression node as the
// `autoLinkTransfer` key. Enabled means it emits `type == 'TRANSFER'`; disabled
// pins it to `false` so the runner never tries to link.
const TRANSFER_KEY = "autoLinkTransfer";
const TRANSFER_ON = "type == 'TRANSFER'";

type ExprContent = { expressions: { id: string; key: string; value: string }[] };

function transferExprNode(graph: Graph): Node | undefined {
  return graph.nodes.find(
    (n) =>
      n.type === "expressionNode" &&
      ((n.content as ExprContent | undefined)?.expressions ?? []).some((e) => e.key === TRANSFER_KEY),
  );
}

export function readTransferAutoLink(graph: Graph): boolean {
  const node = transferExprNode(graph);
  if (!node) return false;
  const expr = (node.content as ExprContent).expressions.find((e) => e.key === TRANSFER_KEY);
  return expr?.value === TRANSFER_ON;
}

/** Turn transfer auto-linking on or off, creating the expression node (wired
 *  input → node → output) if the graph doesn't have one yet. */
export function setTransferAutoLink(graph: Graph, enabled: boolean): void {
  let node = transferExprNode(graph);
  if (!node) {
    node = {
      id: id("expr"),
      type: "expressionNode",
      name: "Transfers",
      position: { x: 380, y: 160 },
      content: { expressions: [{ id: id("e"), key: TRANSFER_KEY, value: "false" }] },
    };
    graph.nodes.push(node);
    const input = findByType(graph, "inputNode");
    const output = findByType(graph, "outputNode");
    if (input) graph.edges.push({ id: id("edge"), type: "edge", sourceId: input.id, targetId: node.id });
    if (output) graph.edges.push({ id: id("edge"), type: "edge", sourceId: node.id, targetId: output.id });
  }
  const expr = (node.content as ExprContent).expressions.find((e) => e.key === TRANSFER_KEY)!;
  expr.value = enabled ? TRANSFER_ON : "false";
}
