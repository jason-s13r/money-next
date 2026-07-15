import type { Account as AkahuAccount, Transaction as AkahuTransaction } from "akahu";
import { db } from "../db";
import { reconcileConflict } from "./conflicts";
import type { Prisma } from "../../generated/prisma/client";
import { OTHER_INCOME_GROUP } from "./nzfcc";
import { DAY_MS, type SyncArgs } from "./shared";

/** First run has no high-water mark, so pull this much history. */
const DEFAULT_LOOKBACK_DAYS = 10 * 365;

/**
 * On an incremental sync, rewind slightly past the newest transaction we hold.
 * Transactions can settle late and have their details revised after they first
 * appear, so a strict `> lastTransactionDate` filter would silently miss them.
 */
const OVERLAP_DAYS = 7;

/** `EnrichedTransaction` adds merchant/category/meta; raw transactions lack them. */
function isEnriched(
  tx: AkahuTransaction,
): tx is Extract<AkahuTransaction, { category: unknown }> {
  return "category" in tx || "merchant" in tx || "meta" in tx;
}

export async function syncTransactions(args: SyncArgs, accounts: AkahuAccount[]): Promise<string[]> {
  const knownAccountIds = new Set(accounts.map((a) => a._id));
  const { akahuClient, akahuUserToken } = await import("../akahu");
  const akahu = akahuClient();
  const token = akahuUserToken();

  const state = await db.syncState.findUnique({ where: { id: "singleton" } });

  let start: Date;
  if (args.days !== undefined) {
    start = new Date(Date.now() - args.days * DAY_MS);
  } else if (args.full || !state?.lastTransactionDate) {
    start = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * DAY_MS);
  } else {
    start = new Date(state.lastTransactionDate.getTime() - OVERLAP_DAYS * DAY_MS);
  }

  console.log(`transactions: fetching since ${start.toISOString()}`);

  let cursor: string | undefined;
  const syncedIds: string[] = [];
  let synced = 0;
  let skipped = 0;
  let newest: Date | undefined = state?.lastTransactionDate ?? undefined;

  do {
    const page = await akahu.transactions.list(token, {
      start: start.toISOString(),
      cursor,
    });

    // What we already hold for this page's rows, so the sync can tell a
    // user-owned enrichment field (which it must not overwrite) from an
    // Akahu-owned one, and diff against any conflict already recorded.
    const pageIds = page.items.map((tx) => tx._id);
    const [existingRows, existingConflicts] = await Promise.all([
      db.transaction.findMany({
        where: { id: { in: pageIds } },
        select: {
          id: true,
          categoryId: true,
          category: { select: { name: true } },
          categorySource: true,
          merchantId: true,
          merchant: { select: { name: true } },
          merchantSource: true,
        },
      }),
      db.transactionConflict.findMany({ where: { transactionId: { in: pageIds } } }),
    ]);
    const priorById = new Map(existingRows.map((row) => [row.id, row]));
    const conflictByKey = new Map(
      existingConflicts.map((c) => [`${c.transactionId}:${c.field}`, c]),
    );

    // Merchants recur across a page and across pages; collect the distinct ones
    // so each is stored once, then upserted *ahead* of the transactions that
    // reference it so the foreign key always resolves. Keyed by id.
    const merchants = new Map<string, { id: string; name: string; website: string | null; logo: string | null }>();
    // Category groups and categories are collected and upserted the same way, as a
    // safety net so a `categoryGroupId`/`categoryId` FK never dangles when Akahu
    // returns one the NZFCC mirror hasn't caught up to. The enrichment carries no
    // `direction`, so it is inferred from the amount sign (corrected on the next
    // NZFCC refresh). Keyed by id.
    const categoryGroups = new Map<string, string>();
    const categories = new Map<string, { id: string; name: string; direction: string; groupId: string | null }>();

    const txOps: Prisma.PrismaPromise<unknown>[] = [];
    const conflictOps: Prisma.PrismaPromise<unknown>[] = [];

    for (const tx of page.items) {
      // A transaction can outlive the account it belonged to; inserting it
      // would violate the foreign key, so drop it rather than fail the run.
      if (!knownAccountIds.has(tx._account)) {
        skipped++;
        continue;
      }

      const date = new Date(tx.date);
      if (!newest || date > newest) newest = date;

      const enriched = isEnriched(tx) ? tx : undefined;
      // Only reference a merchant we can also store, so `merchantId` never points
      // at a Merchant row that was never created.
      const merchant = enriched?.merchant;
      const merchantId = merchant?._id && merchant.name ? merchant._id : null;
      if (merchantId) {
        merchants.set(merchantId, {
          id: merchantId,
          name: merchant!.name,
          website: merchant!.website ?? null,
          logo: enriched?.meta?.logo ?? null,
        });
      }

      // Akahu nests the group under a scheme key (`personal_finance`); the value
      // holds the *real* group id and name. An uncategorised inflow carries no
      // group, so it falls back to the invented "Other Income" group.
      const groupEntry = enriched?.category?.groups
        ? Object.values(enriched.category.groups)[0]
        : undefined;
      const categoryGroupId =
        groupEntry?._id ?? (tx.amount > 0 ? OTHER_INCOME_GROUP._id : null);
      const categoryGroupName =
        groupEntry?.name ?? (tx.amount > 0 ? OTHER_INCOME_GROUP.name : null);
      if (categoryGroupId && categoryGroupName) {
        categoryGroups.set(categoryGroupId, categoryGroupName);
      }
      // Back the category too, with `direction` inferred from the amount sign.
      const category = enriched?.category;
      if (category?._id && category.name) {
        categories.set(category._id, {
          id: category._id,
          name: category.name,
          direction: tx.amount < 0 ? "debit" : "credit",
          groupId: categoryGroupId,
        });
      }

      const conversion = enriched?.meta?.conversion;
      const row = {
        accountId: tx._account,
        connectionId: tx._connection,
        date,
        description: tx.description,
        amount: tx.amount,
        balance: tx.balance ?? null,
        type: tx.type,
        hash: tx.hash ?? null,
        merchantId,
        categoryId: enriched?.category?._id ?? null,
        categoryGroupId,
        particulars: enriched?.meta?.particulars ?? null,
        code: enriched?.meta?.code ?? null,
        reference: enriched?.meta?.reference ?? null,
        otherAccount: enriched?.meta?.other_account ?? null,
        cardSuffix: enriched?.meta?.card_suffix ?? null,
        conversionAmount: conversion?.amount ?? null,
        conversionCurrency: conversion?.currency ?? null,
        conversionRate: conversion?.rate ?? null,
        logo: enriched?.meta?.logo ?? null,
        createdAt: tx.created_at ? new Date(tx.created_at) : null,
        updatedAt: tx.updated_at ? new Date(tx.updated_at) : null,
      };

      // A user-owned field is left exactly as the user set it: drop it from the
      // update payload, and instead reconcile it into a conflict. `source` itself
      // is never written here — only the server action promotes a field to
      // `user`, and a new row defaults to `akahu`.
      const prior = priorById.get(tx._id);
      const update: Record<string, unknown> = { ...row };

      if (prior?.categorySource === "user") {
        delete update.categoryId;
        delete update.categoryGroupId;
        const op = reconcileConflict(
          "category",
          tx._id,
          prior.categoryId,
          prior.category?.name ?? null,
          row.categoryId,
          enriched?.category?.name ?? null,
          conflictByKey.get(`${tx._id}:category`),
        );
        if (op) conflictOps.push(op);
      }

      if (prior?.merchantSource === "user") {
        delete update.merchantId;
        const op = reconcileConflict(
          "merchant",
          tx._id,
          prior.merchantId,
          prior.merchant?.name ?? null,
          row.merchantId,
          merchant?.name ?? null,
          conflictByKey.get(`${tx._id}:merchant`),
        );
        if (op) conflictOps.push(op);
      }

      synced++;
      syncedIds.push(tx._id);
      txOps.push(
        db.transaction.upsert({
          where: { id: tx._id },
          create: { id: tx._id, ...row },
          update: update as Prisma.TransactionUpdateInput,
        }),
      );
    }

    // One SQLite write transaction per page keeps this fast and means a crash
    // mid-page can't leave a partially-applied page behind. Groups lead, then the
    // categories that point at them, then merchants — so every transaction that
    // follows finds the rows it points at; conflict ops trail the transaction
    // upserts they reference.
    await db.$transaction([
      ...[...categoryGroups].map(([id, name]) =>
        db.categoryGroup.upsert({ where: { id }, create: { id, name }, update: { name } }),
      ),
      ...[...categories.values()].map((category) =>
        db.category.upsert({
          where: { id: category.id },
          create: category,
          // Don't clobber the authoritative NZFCC `direction`/`groupId` with the
          // inferred values on a row that already exists; only fill a missing name.
          update: { name: category.name },
        }),
      ),
      ...[...merchants.values()].map((merchant) =>
        db.merchant.upsert({
          where: { id: merchant.id },
          create: merchant,
          update: { name: merchant.name, website: merchant.website, logo: merchant.logo },
        }),
      ),
      ...txOps,
      ...conflictOps,
    ]);

    cursor = page.cursor.next ?? undefined;
    process.stdout.write(`\rtransactions: ${synced} upserted...`);
  } while (cursor);

  process.stdout.write("\n");
  if (skipped > 0) {
    console.log(`transactions: ${skipped} skipped (unknown account)`);
  }

  // Only advance the high-water mark once the whole run succeeded, so a failure
  // mid-sync doesn't cause the next run to skip the window it never finished.
  if (newest) {
    await db.syncState.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", lastTransactionDate: newest },
      update: { lastTransactionDate: newest },
    });
  }

  return syncedIds;
}
