import "server-only";

// Learned-rule helpers: derive a match predicate from a hand-classified transaction,
// then fold it into the active decision graph. Split into:
//   match.ts  — tokenisation and predicate derivation
//   graph.ts  — graph node/edge types and learned-table wiring
//   upsert.ts — folding a new rule into the table
//   edit.ts   — rewriting a rule that already exists
//   read.ts   — parsing the table back for display
//   transfers.ts — the transfer auto-link toggle
//   id.ts     — short random ids

export { buildExpression, deriveMatch, distinctiveTokens, normalizeToken } from "./match";
export type { DerivedMatch } from "./match";

export { LEARNED_TABLE_ID, ensureTable, learnedTable, normalizeTable } from "./graph";
export type { Graph, Node, Edge, TableContent, TableRule } from "./graph";

export { upsertLearnedRule } from "./upsert";
export type { LearnedOutputs, UpsertResult } from "./upsert";

export { updateLearnedRule, validateEdit } from "./edit";
export type { EditValidation, RuleEdit, ValidatedEdit } from "./edit";

export {
  parseMatch,
  matchesTransaction,
  readLearnedRules,
  deleteLearnedRule,
} from "./read";
export type { ParsedMatch, LearnedRuleView } from "./read";

export { readTransferAutoLink, setTransferAutoLink } from "./transfers";

export { id } from "./id";
