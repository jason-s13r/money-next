import { RULE_SOURCE, type RuleInput, type RuleOutput, type RuleTx } from "./types";

/** Build the flat context a decision graph is evaluated against. */
export function buildInput(tx: RuleTx): RuleInput {
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
    merchantName: tx.merchant?.name ?? null,
    categoryId: tx.categoryId,
    categoryName: tx.category?.name ?? null,
    categoryGroup: tx.categoryGroup?.name ?? null,
    particulars: tx.particulars,
    code: tx.code,
    reference: tx.reference,
    otherAccount: tx.otherAccount,
    cardSuffix: tx.cardSuffix,
    isTransfer: tx.transferGroupId != null,
  };
}
