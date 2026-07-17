import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { getDb } from "../db/request";
import { accountMoney, transactionMoney } from "../money";
import {
  readLearnedRules,
  readTransferAutoLink,
  matchesTransaction,
  type Graph,
  type LearnedRuleView,
} from "../rules/learning";

// Single-record and catalog reads for the transaction detail page: the enrichment
// pickers (categories, merchants), one transaction with its open conflicts, one
// merchant, and the rules that would act on a transaction. Like the rest of the
// read layer these touch only the database and await `connection()` first.

/**
 * The whole NZFCC catalog, for the category picker on a transaction. Ordered by
 * group then name so the dropdown can show categories under their spending group.
 */
export const getCategories = cache(async () => {
  await connection();
  const db = await getDb();
  const rows = await db.category.findMany({
    orderBy: [{ group: { name: "asc" } }, { name: "asc" }],
    select: { id: true, name: true, direction: true, group: { select: { name: true } } },
  });
  // Flatten the group name so callers read `groupName` without a nested access.
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    direction: c.direction,
    groupName: c.group?.name ?? null,
  }));
});

/** Every merchant on record, for the merchant picker on a transaction. */
export const getMerchants = cache(async () => {
  await connection();
  const db = await getDb();
  return db.merchant.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, logo: true },
  });
});

/** A merchant by id, for its page's title and to 404 an unknown id. */
export const getMerchant = cache(async (id: string) => {
  await connection();
  const db = await getDb();
  return db.merchant.findUnique({
    where: { id },
    select: { id: true, name: true, website: true, logo: true },
  });
});

export const getTransaction = cache(async (id: string) => {
  await connection();
  const db = await getDb();
  const tx = await db.transaction.findUnique({
    where: { id },
    // Only unresolved conflicts surface on the page; a dismissed one is settled
    // and stays out of the way until a future sync re-opens it.
    include: {
      account: { include: { connection: { select: { id: true, name: true, logo: true } } } },
      conflicts: { where: { status: "open" } },
      merchant: { select: { name: true } },
      category: { select: { name: true } },
      categoryGroup: { select: { name: true } },
    },
  });
  if (!tx) return null;

  // Both the row and its nested account carry money columns, and this whole
  // object is handed to client components — so both have to leave `Decimal`
  // behind here (see lib/server/money.ts).
  return { ...transactionMoney(tx), account: accountMoney(tx.account) };
});

export type MatchingRule = LearnedRuleView & {
  categoryName: string | null;
  merchantName: string | null;
  /** The first matching rule wins (the table's `first` hit policy); the rest are
   *  shadowed by it and never fire for this transaction. */
  applied: boolean;
};

/**
 * The rules that act on one transaction, for the "Automation" panel on its page.
 * A pure predicate test against the active graph (see `matchesTransaction`) — no
 * engine round-trip — with the first match flagged `applied` and the outputs'
 * ids resolved to names. `transferMatches` is the auto-link rule's verdict.
 */
export async function getRulesForTransaction(tx: {
  type: string;
  description: string;
}): Promise<{ matching: MatchingRule[]; transferMatches: boolean }> {
  await connection();
  const db = await getDb();
  const doc = await db.ruleDocument.findFirst({ where: { active: true } });
  if (!doc) return { matching: [], transferMatches: false };

  const graph = JSON.parse(doc.content) as Graph;
  const matches = readLearnedRules(graph).filter((rule) => matchesTransaction(rule.match, tx));
  if (matches.length === 0) {
    return { matching: [], transferMatches: readTransferAutoLink(graph) && tx.type === "TRANSFER" };
  }

  // Resolve just the ids the matching rules reference.
  const categoryIds = matches.map((r) => r.categoryId).filter((v): v is string => v != null);
  const merchantIds = matches.map((r) => r.merchantId).filter((v): v is string => v != null);
  const [categories, merchants] = await Promise.all([
    db.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }),
    db.merchant.findMany({ where: { id: { in: merchantIds } }, select: { id: true, name: true } }),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const merchantName = new Map(merchants.map((m) => [m.id, m.name]));

  const matching: MatchingRule[] = matches.map((rule, i) => ({
    ...rule,
    categoryName: rule.categoryId ? categoryName.get(rule.categoryId) ?? rule.categoryId : null,
    merchantName: rule.merchantId ? merchantName.get(rule.merchantId) ?? rule.merchantId : null,
    applied: i === 0,
  }));
  return { matching, transferMatches: readTransferAutoLink(graph) && tx.type === "TRANSFER" };
}
