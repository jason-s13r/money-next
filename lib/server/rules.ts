// Transaction automation, powered by the GoRules Zen engine. The active
// `RuleDocument` holds a JDM decision graph authored in the visual editor at
// `/rules`; here we evaluate every transaction against it and apply what it
// decides — a category, a merchant, or the go-ahead to auto-link a transfer.
//
// No `import "server-only"`: this runs both inside the request (the manual
// "apply rules" action, and the per-sync pass) and inside the plain-Node ingest
// script, exactly like lib/server/sync.ts. `@gorules/zen-engine` is a native
// addon and is kept out of the Next bundle via `serverExternalPackages`.

import { ZenEngine, type ZenDecision } from "@gorules/zen-engine";
import { db } from "./db";
import { findAutoTransferLeg, linkTransferLegs } from "./transfers";
import type { Prisma } from "../generated/prisma/client";

// The `source` value stamped on any field a rule sets, alongside the existing
// `akahu` (mirrored) and `user` (hand-set) owners. A rule outranks `akahu` but
// never `user`: a hand-set field is left untouched (see `applyOutput`).
export const RULE_SOURCE = "rule";

/**
 * The flat context a decision graph is evaluated against — one transaction, with
 * its account joined in and a couple of derived conveniences (`direction`,
 * `isTransfer`). Field names are the identifiers rules reference in their
 * expressions and tables, so treat this as the public input contract.
 */
export type RuleInput = {
  id: string;
  date: string;
  description: string;
  amount: number;
  direction: "in" | "out";
  type: string;
  currency: string | null;
  accountId: string;
  accountName: string;
  accountType: string;
  connectionId: string;
  merchantId: string | null;
  merchantName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryGroup: string | null;
  particulars: string | null;
  code: string | null;
  reference: string | null;
  otherAccount: string | null;
  cardSuffix: string | null;
  isTransfer: boolean;
};

/**
 * What a decision graph may return, all optional. `categoryId`/`merchantId` must
 * name a row that exists (an unknown id is ignored, not written, so a typo can't
 * corrupt a transaction); `autoLinkTransfer` asks the runner to find and link the
 * opposite leg when it can do so unambiguously (see `findAutoTransferLeg`).
 */
export type RuleOutput = {
  categoryId?: string | null;
  merchantId?: string | null;
  autoLinkTransfer?: boolean;
};

// The transaction fields the runner needs: enough to build the input, plus the
// provenance/grouping columns that gate what may be written.
const txSelect = {
  id: true,
  date: true,
  description: true,
  amount: true,
  type: true,
  accountId: true,
  connectionId: true,
  merchantId: true,
  merchantName: true,
  merchantSource: true,
  categoryId: true,
  categoryName: true,
  categoryGroup: true,
  categorySource: true,
  particulars: true,
  code: true,
  reference: true,
  otherAccount: true,
  cardSuffix: true,
  transferGroupId: true,
  account: { select: { name: true, type: true, currency: true } },
} satisfies Prisma.TransactionSelect;

type RuleTx = Prisma.TransactionGetPayload<{ select: typeof txSelect }>;

function buildInput(tx: RuleTx): RuleInput {
  return {
    id: tx.id,
    date: tx.date.toISOString(),
    description: tx.description,
    amount: tx.amount,
    direction: tx.amount > 0 ? "in" : "out",
    type: tx.type,
    currency: tx.account.currency,
    accountId: tx.accountId,
    accountName: tx.account.name,
    accountType: tx.account.type,
    connectionId: tx.connectionId,
    merchantId: tx.merchantId,
    merchantName: tx.merchantName,
    categoryId: tx.categoryId,
    categoryName: tx.categoryName,
    categoryGroup: tx.categoryGroup,
    particulars: tx.particulars,
    code: tx.code,
    reference: tx.reference,
    otherAccount: tx.otherAccount,
    cardSuffix: tx.cardSuffix,
    isTransfer: tx.transferGroupId != null,
  };
}

// Keep each `id: { in: [...] }` batch well under SQLite's default bound-parameter
// ceiling (999) so a large sync's id list can't overflow it.
const ID_QUERY_CHUNK = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

export type RulesRunSummary = {
  /** Whether an active rule document existed to run at all. */
  ran: boolean;
  evaluated: number;
  categorised: number;
  merchantsSet: number;
  transfersLinked: number;
  /** Transactions whose evaluation threw (a broken expression, say); the run
   *  continues past them so one bad row can't abandon a whole sync. */
  errors: number;
};

/** One edit a rule made to a transaction, for the run report. */
type RuleChange = {
  field: "category" | "merchant" | "transfer";
  fromLabel: string | null;
  toLabel: string | null;
};

/**
 * Apply one decision result to one transaction, respecting field ownership. A
 * field owned by `user` is never touched; otherwise a rule value that differs
 * from what's stored is written and the field is stamped `rule`. Returns the
 * changes it made (empty when the rule left the transaction untouched), both to
 * tally the summary and to record the per-transaction run log.
 */
async function applyOutput(tx: RuleTx, output: RuleOutput): Promise<RuleChange[]> {
  const changes: RuleChange[] = [];
  // Unchecked so the scalar `merchantId`/`categoryId` FK columns can be written
  // directly (the checked update input routes `merchantId` through the relation).
  const data: Prisma.TransactionUncheckedUpdateInput = {};

  if (
    output.categoryId &&
    tx.categorySource !== "user" &&
    output.categoryId !== tx.categoryId
  ) {
    const category = await db.category.findUnique({ where: { id: output.categoryId } });
    if (category) {
      data.categoryId = category.id;
      data.categoryName = category.name;
      data.categoryGroup = category.groupName;
      data.categorySource = RULE_SOURCE;
      changes.push({ field: "category", fromLabel: tx.categoryName, toLabel: category.name });
    }
  }

  if (
    output.merchantId &&
    tx.merchantSource !== "user" &&
    output.merchantId !== tx.merchantId
  ) {
    const merchant = await db.merchant.findUnique({ where: { id: output.merchantId } });
    if (merchant) {
      data.merchantId = merchant.id;
      data.merchantName = merchant.name;
      data.merchantSource = RULE_SOURCE;
      changes.push({ field: "merchant", fromLabel: tx.merchantName, toLabel: merchant.name });
    }
  }

  if (Object.keys(data).length > 0) {
    await db.transaction.update({ where: { id: tx.id }, data });
  }

  // Transfer auto-linking is relational, so it can't be a column write: the graph
  // only says "this looks like a transfer"; we find the opposite leg and group it,
  // and only when the match is unambiguous.
  if (output.autoLinkTransfer === true && tx.transferGroupId == null) {
    const leg = await findAutoTransferLeg({
      id: tx.id,
      amount: tx.amount,
      date: tx.date,
      accountId: tx.accountId,
      currency: tx.account.currency,
    });
    if (leg && (await linkTransferLegs(tx.id, leg.id))) {
      const legTx = await db.transaction.findUnique({
        where: { id: leg.id },
        select: { description: true },
      });
      changes.push({ field: "transfer", fromLabel: null, toLabel: legTx?.description ?? leg.id });
    }
  }

  return changes;
}

/**
 * Evaluate the active decision against a set of transactions (or all of them when
 * `transactionIds` is omitted) and apply each result. Used two ways: the manual
 * backfill from `/rules`, and the per-sync pass over freshly-ingested rows.
 *
 * Builds the engine once and disposes it at the end; a per-transaction failure is
 * counted and stepped over rather than aborting the batch.
 */
export async function runRules(opts?: {
  transactionIds?: string[];
  /** What triggered the run, for the log. Defaults to `manual`. */
  trigger?: "sync" | "manual";
}): Promise<RulesRunSummary> {
  const trigger = opts?.trigger ?? "manual";
  const doc = await db.ruleDocument.findFirst({
    where: { active: true },
    orderBy: { updatedAt: "desc" },
  });
  const summary: RulesRunSummary = {
    ran: false,
    evaluated: 0,
    categorised: 0,
    merchantsSet: 0,
    transfersLinked: 0,
    errors: 0,
  };
  if (!doc) return summary;
  if (opts?.transactionIds && opts.transactionIds.length === 0) {
    summary.ran = true;
    return summary;
  }
  summary.ran = true;

  const startedAt = new Date();
  const engine = new ZenEngine();
  let decision: ZenDecision;
  try {
    decision = engine.createDecision(JSON.parse(doc.content));
  } catch (error) {
    engine.dispose();
    const message = error instanceof Error ? error.message : String(error);
    // Record the failure so a persistently-broken graph is visible in the log.
    await db.ruleRun.create({
      data: { startedAt, finishedAt: new Date(), trigger, status: "failed", error: message },
    });
    throw new Error(`Active rule document "${doc.name}" is not a valid decision graph: ${message}`);
  }

  // Every edit made this run, recorded against the RuleRun at the end.
  const applications: { transactionId: string; field: string; fromLabel: string | null; toLabel: string | null }[] = [];

  try {
    // A sync can hand us thousands of freshly-upserted ids; splatting them all
    // into one `id: { in: [...] }` blows SQLite's bound-parameter limit, so fetch
    // in chunks. When no ids are given (the manual backfill) it's a single query.
    const txs: RuleTx[] = [];
    const idBatches = opts?.transactionIds
      ? chunk(opts.transactionIds, ID_QUERY_CHUNK)
      : [undefined];
    for (const ids of idBatches) {
      const batch = await db.transaction.findMany({
        where: ids ? { id: { in: ids } } : {},
        select: txSelect,
        orderBy: [{ date: "desc" }, { id: "desc" }],
      });
      txs.push(...batch);
    }
    // Each batch is ordered, but the concatenation across batches isn't; restore
    // the global date-desc, id-desc order so a run is deterministic regardless of
    // how the id list was chunked.
    if (idBatches.length > 1) {
      txs.sort((a, b) =>
        b.date.getTime() - a.date.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    }

    for (const tx of txs) {
      summary.evaluated++;
      try {
        const response = await decision.evaluate(buildInput(tx));
        const output = (response.result ?? {}) as RuleOutput;
        for (const change of await applyOutput(tx, output)) {
          applications.push({ transactionId: tx.id, ...change });
          if (change.field === "category") summary.categorised++;
          else if (change.field === "merchant") summary.merchantsSet++;
          else if (change.field === "transfer") summary.transfersLinked++;
        }
      } catch {
        summary.errors++;
      }
    }
  } finally {
    engine.dispose();
  }

  // Log the run only when it actually did something (or hit errors), so the report
  // stays a record of changes rather than a heartbeat of every no-op sync.
  if (applications.length > 0 || summary.errors > 0) {
    await db.ruleRun.create({
      data: {
        startedAt,
        finishedAt: new Date(),
        trigger,
        status: "success",
        evaluated: summary.evaluated,
        categorised: summary.categorised,
        merchantsSet: summary.merchantsSet,
        transfersLinked: summary.transfersLinked,
        errors: summary.errors,
        applications: { create: applications },
      },
    });
  }

  return summary;
}

/**
 * A minimal, valid starter graph for a new rule document: it passes every
 * transaction Akahu already typed as a `TRANSFER` to the auto-linker, which is
 * safe because that linker only acts on an unambiguous opposite leg. Everything
 * else — category and merchant rules — is left for the author to add. Kept as a
 * value (not a file) so a fresh document opens on something runnable.
 */
export function defaultDecisionGraph(): { nodes: unknown[]; edges: unknown[] } {
  return {
    nodes: [
      {
        id: "input",
        type: "inputNode",
        name: "Transaction",
        position: { x: 100, y: 160 },
      },
      {
        id: "rules",
        type: "expressionNode",
        name: "Automations",
        position: { x: 380, y: 160 },
        content: {
          expressions: [
            // Hand transfers to the auto-linker. Add your own category/merchant
            // rules here, e.g. `categoryId: contains(lower(description), 'uber')
            // ? 'nzfcc_...' : null`.
            { id: "auto-transfer", key: "autoLinkTransfer", value: "type == 'TRANSFER'" },
          ],
        },
      },
      {
        id: "output",
        type: "outputNode",
        name: "Result",
        position: { x: 660, y: 160 },
      },
    ],
    edges: [
      { id: "e1", type: "edge", sourceId: "input", targetId: "rules" },
      { id: "e2", type: "edge", sourceId: "rules", targetId: "output" },
    ],
  };
}
