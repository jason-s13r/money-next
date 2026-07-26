import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { getDb } from "../db/request";
import { convert, FALLBACK_DISPLAY_CURRENCY as DISPLAY_CURRENCY, loadRates } from "../currency";
import { accountMoney, moneySum, transactionMoney } from "../money";
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

/** The workspace's labels, for the tag picker on a transaction or bulk action. */
export const getLabels = cache(async () => {
  await connection();
  const db = await getDb();
  return db.label.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
});

/**
 * The workspace's labels with how many transactions each tags and their net
 * total, for the index page. The net is folded per account currency — each
 * account's amount converts at its own rate before being added (the same
 * `netInDisplay` fold the merchants index uses), since a raw sum across
 * AUD/USD/NZD would be nonsense.
 */
export const getLabelsWithCounts = cache(async () => {
  await connection();
  const db = await getDb();
  const [labels, joins] = await Promise.all([
    db.label.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.transactionLabel.findMany({
      select: {
        labelId: true,
        transaction: { select: { amount: true, account: { select: { currency: true } } } },
      },
    }),
  ]);

  const currencies = new Set<string>([DISPLAY_CURRENCY]);
  for (const j of joins) {
    if (j.transaction.account.currency) currencies.add(j.transaction.account.currency);
  }
  const rates = await loadRates([...currencies]);

  const counts = new Map<string, number>();
  const nets = new Map<string, number>();
  for (const j of joins) {
    counts.set(j.labelId, (counts.get(j.labelId) ?? 0) + 1);
    const raw = moneySum(j.transaction.amount);
    const inDisplay =
      convert(raw, j.transaction.account.currency, DISPLAY_CURRENCY, rates) ?? raw;
    nets.set(j.labelId, (nets.get(j.labelId) ?? 0) + inDisplay);
  }

  return labels.map((l) => ({
    id: l.id,
    name: l.name,
    count: counts.get(l.id) ?? 0,
    net: nets.get(l.id) ?? 0,
  }));
});

/**
 * Every merchant that tags at least one of this workspace's transactions, with
 * how many, for the merchants index. The counts come from a groupBy over the
 * workspace's own transactions (the scoped client injects the workspace), so a
 * merchant shared from Akahu's global catalog is counted only for the rows in
 * *this* workspace — and merchants with no transactions here never appear.
 *
 * `userCreated` marks the ones a user minted (a name they typed): those carry a
 * `workspaceId`, where the global catalog's are `null` (see the Merchant model).
 */
export const getMerchantsWithCounts = cache(async () => {
  await connection();
  const db = await getDb();

  // Count and net total per merchant, over this workspace's own transactions.
  // Grouped by account as well as merchant so each currency's subtotal converts at
  // its own rate before being added — the per-account fold `netInDisplay` uses,
  // since a raw sum across AUD/USD/NZD would be nonsense.
  const grouped = await db.transaction.groupBy({
    by: ["merchantId", "accountId"],
    where: { merchantId: { not: null } },
    _count: { _all: true },
    _sum: { amount: true },
  });
  const merchantIds = [
    ...new Set(grouped.map((g) => g.merchantId).filter((v): v is string => v != null)),
  ];
  if (merchantIds.length === 0) return [];

  const accountIds = [...new Set(grouped.map((g) => g.accountId))];
  const [merchants, accounts] = await Promise.all([
    db.merchant.findMany({
      where: { id: { in: merchantIds } },
      select: { id: true, name: true, logo: true, workspaceId: true },
    }),
    db.account.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, currency: true },
    }),
  ]);
  const currencyById = new Map(accounts.map((a) => [a.id, a.currency]));
  const rates = await loadRates([...accounts.map((a) => a.currency), DISPLAY_CURRENCY]);

  const counts = new Map<string, number>();
  const nets = new Map<string, number>();
  for (const g of grouped) {
    if (g.merchantId == null) continue;
    counts.set(g.merchantId, (counts.get(g.merchantId) ?? 0) + g._count._all);
    const raw = moneySum(g._sum.amount);
    const inDisplay =
      convert(raw, currencyById.get(g.accountId) ?? null, DISPLAY_CURRENCY, rates) ?? raw;
    nets.set(g.merchantId, (nets.get(g.merchantId) ?? 0) + inDisplay);
  }

  return merchants
    .map((m) => ({
      id: m.id,
      name: m.name,
      logo: m.logo,
      count: counts.get(m.id) ?? 0,
      net: nets.get(m.id) ?? 0,
      userCreated: m.workspaceId !== null,
    }))
    // Busiest first, then alphabetical.
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "en-NZ"));
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
      labels: {
        orderBy: { label: { name: "asc" } },
        select: { label: { select: { id: true, name: true } } },
      },
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
