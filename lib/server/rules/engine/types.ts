import type { Prisma } from "../../../generated/prisma/client";
import type { ChangeSource, FieldChangeEntry } from "../../changes";

// The `source` value stamped on any field a rule sets, alongside the existing
// `akahu` (mirrored) and `user` (hand-set) owners. A rule outranks `akahu` but
// never `user`: a hand-set field is left untouched (see `applyOutput`).
//
// The same string the field change log stamps on a rule's rows, and typed as
// such so the two vocabularies cannot drift apart.
export const RULE_SOURCE: ChangeSource = "rule";

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
 * opposite leg when it can do so unambiguously.
 *
 * `labelName` is a name, not an id, and it need not exist yet — the runner
 * get-or-creates it (`tagTransactions`). It is the only tag a run writes; a rule
 * that sets nothing else applies no label, since only a changed transaction is
 * tagged.
 */
export type RuleOutput = {
  categoryId?: string | null;
  merchantId?: string | null;
  labelName?: string | null;
  autoLinkTransfer?: boolean;
};

// The transaction fields the runner needs: enough to build the input, plus the
// provenance/grouping columns that gate what may be written.
export const txSelect = {
  id: true,
  date: true,
  description: true,
  amount: true,
  type: true,
  accountId: true,
  connectionId: true,
  merchantId: true,
  merchant: { select: { name: true } },
  merchantSource: true,
  categoryId: true,
  category: { select: { name: true } },
  categoryGroupId: true,
  categoryGroup: { select: { name: true } },
  categorySource: true,
  particulars: true,
  code: true,
  reference: true,
  otherAccount: true,
  cardSuffix: true,
  transferGroupId: true,
  account: { select: { name: true, type: true, currency: true } },
} satisfies Prisma.TransactionSelect;

/**
 * A transaction as the runner sees it: the selected columns, but with `amount`
 * already out of Prisma's `Decimal` and into a plain number.
 *
 * The graph compares `amount` numerically and the engine is handed this object
 * as its input, so a decimal.js instance must never reach it — the runner
 * converts as it fetches (see `runRules`).
 */
export type RuleTx = Omit<Prisma.TransactionGetPayload<{ select: typeof txSelect }>, "amount"> & {
  amount: number;
};

/**
 * One edit a rule made to a transaction — the run report's row, and the field
 * change log's. They are the same record: the log *is* the run report now, with a
 * `source` column that lets the sync and a person write their edits into it too.
 */
export type RuleChange = Omit<FieldChangeEntry, "transactionId">;

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
