import { WRITE_TOOLS } from "./budget-write";
import { ENRICH_WRITE_TOOLS } from "./enrich-write";
import { LABEL_READ_TOOLS, LABEL_WRITE_TOOLS } from "./labels";
import { READ_TOOLS } from "./read";
import { RULE_READ_TOOLS, RULE_WRITE_TOOLS } from "./rules";
import { TRANSACTION_READ_TOOLS } from "./transactions";
import type { Tool } from "./registry";

// The whole tool surface, in one list.
//
// The chat is offered all of it, minus the tools whose `write` scope the caller does not
// hold (`availableTools`) — budgets and enrichment are separate grants, so a reader may
// well be offered exactly one of the two write halves. The budget inference deliberately
// takes a different, smaller set — see lib/server/budget/llm.ts — because it is building
// a budget from nothing and neither the existing budgets nor the enrichment layer are
// its business.
//
// Roughly, the surface is: the budget (read.ts, budget-write.ts), the ledger
// (transactions.ts, enrich-write.ts), and the two things that make an edit stick beyond
// the row it was made on — labels.ts for the household's own vocabulary, rules.ts for
// the standing automations.

export const CHAT_TOOLS: Tool[] = [
  ...READ_TOOLS,
  ...TRANSACTION_READ_TOOLS,
  ...LABEL_READ_TOOLS,
  ...RULE_READ_TOOLS,
  ...WRITE_TOOLS,
  ...ENRICH_WRITE_TOOLS,
  ...LABEL_WRITE_TOOLS,
  ...RULE_WRITE_TOOLS,
];

export {
  availableTools,
  repairLooseToolCall,
  toolsForSdk,
  type Permissions,
  type Tool,
  type ToolContext,
  type ToolMeta,
  type WriteScope,
} from "./registry";
export {
  eagerHistory,
  lazyFx,
  lazyHistory,
  loadCatalog,
  loadHistory,
  type Area,
  type History,
  type TxRow,
} from "./history";
