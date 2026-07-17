import type { ScopedDb } from "../../db";
import { findAutoTransferLeg, linkTransferLegs } from "../../matching/transfers";
import type { Prisma } from "../../../generated/prisma/client";
import { RULE_SOURCE, type RuleChange, type RuleOutput, type RuleTx } from "./types";

/**
 * Apply one decision result to one transaction, respecting field ownership. A
 * field owned by `user` is never touched; otherwise a rule value that differs
 * from what's stored is written and the field is stamped `rule`. Returns the
 * changes it made (empty when the rule left the transaction untouched), both to
 * tally the summary and to record the per-transaction run log.
 */
export async function applyOutput(
  db: ScopedDb,
  tx: RuleTx,
  output: RuleOutput,
): Promise<RuleChange[]> {
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
      // Keep the denormalised group id in step with the category (real group id).
      data.categoryGroupId = category.groupId;
      data.categorySource = RULE_SOURCE;
      changes.push({
        field: "category",
        fromId: tx.categoryId,
        fromLabel: tx.category?.name ?? null,
        toId: category.id,
        toLabel: category.name,
      });
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
      data.merchantSource = RULE_SOURCE;
      changes.push({
        field: "merchant",
        fromId: tx.merchantId,
        fromLabel: tx.merchant?.name ?? null,
        toId: merchant.id,
        toLabel: merchant.name,
      });
    }
  }

  if (Object.keys(data).length > 0) {
    await db.transaction.update({ where: { id: tx.id }, data });
  }

  // Transfer auto-linking is relational, so it can't be a column write: the graph
  // only says "this looks like a transfer"; we find the opposite leg and group it,
  // and only when the match is unambiguous.
  if (output.autoLinkTransfer === true && tx.transferGroupId == null) {
    const leg = await findAutoTransferLeg(db, {
      id: tx.id,
      amount: tx.amount,
      date: tx.date,
      accountId: tx.accountId,
      currency: tx.account.currency,
    });
    if (leg && (await linkTransferLegs(db, tx.id, leg.id))) {
      const legTx = await db.transaction.findUnique({
        where: { id: leg.id },
        select: { description: true },
      });
      changes.push({ field: "transfer", fromLabel: null, toLabel: legTx?.description ?? leg.id });
    }
  }

  return changes;
}
