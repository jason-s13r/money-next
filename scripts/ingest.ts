/**
 * Pulls accounts and transactions from Akahu into the local SQLite database.
 *
 *   pnpm db:sync              # incremental: since the newest stored transaction
 *   pnpm db:sync --full       # re-fetch the whole history window
 *   pnpm db:sync --days 90    # explicit lookback window
 *
 * Safe to re-run: every row is upserted on its Akahu id, so a sync that dies
 * halfway can simply be run again. Intended to be driven by cron.
 */
import type { Transaction as AkahuTransaction } from "akahu";
import { akahuClient, akahuUserToken } from "../lib/akahu";
import { db } from "../lib/db";
import { reconcileConflict } from "../lib/conflicts";
import { fetchFxRates } from "../lib/fx";
import type { Prisma } from "../lib/generated/prisma/client";
import { fetchNzfccCatalog, OTHER_INCOME_GROUP } from "../lib/nzfcc";

/** First run has no high-water mark, so pull this much history. */
const DEFAULT_LOOKBACK_DAYS = 10 * 365;

/**
 * On an incremental sync, rewind slightly past the newest transaction we hold.
 * Transactions can settle late and have their details revised after they first
 * appear, so a strict `> lastTransactionDate` filter would silently miss them.
 */
const OVERLAP_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

type Args = { full: boolean; days?: number };

function parseArgs(argv: string[]): Args {
  const full = argv.includes("--full");
  const daysFlag = argv.indexOf("--days");
  const days = daysFlag !== -1 ? Number(argv[daysFlag + 1]) : undefined;
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    throw new Error(`--days expects a positive number, got: ${argv[daysFlag + 1]}`);
  }
  return { full, days };
}

/** Snapshots are keyed per-day, so re-running on the same day updates in place. */
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** `EnrichedTransaction` adds merchant/category/meta; raw transactions lack them. */
function isEnriched(
  tx: AkahuTransaction,
): tx is Extract<AkahuTransaction, { category: unknown }> {
  return "category" in tx || "merchant" in tx || "meta" in tx;
}

/**
 * Refresh the NZFCC category catalog from nzfcc.org. Best-effort: the catalog is
 * a slowly-changing lookup table, so a fetch failure logs a warning and lets the
 * financial sync proceed rather than blocking balances and transactions on it.
 */
async function syncCategories(): Promise<void> {
  try {
    const { version, categories } = await fetchNzfccCatalog();

    await db.$transaction(
      categories.map((category) =>
        db.category.upsert({
          where: { id: category.id },
          create: category,
          update: {
            name: category.name,
            direction: category.direction,
            groupId: category.groupId,
            groupName: category.groupName,
          },
        }),
      ),
    );

    console.log(`categories:   ${categories.length} synced (NZFCC ${version})`);
  } catch (error) {
    console.warn(
      `categories:   skipped — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A few days of overlap so a rate revised after first publish is re-fetched. */
const FX_OVERLAP_DAYS = 5;

/**
 * Mirror ECB daily FX rates for every foreign currency we hold, so cross-currency
 * transfer matching (see `getTransferCandidates`) works offline. Best-effort like
 * `syncCategories`: a fetch failure warns and lets the run finish. Incremental —
 * it fetches from just before the newest rate already stored (or the oldest
 * transaction on a first run) up to today, and upserts, so re-runs are cheap.
 */
async function syncFxRates(): Promise<void> {
  try {
    const accounts = await db.account.findMany({
      where: { currency: { not: null } },
      distinct: ["currency"],
      select: { currency: true },
    });
    const currencies = accounts.map((a) => a.currency!).filter(Boolean);
    // With one currency (or none) there is nothing to convert between.
    if (currencies.length < 2) {
      console.log("fx:           skipped — single currency");
      return;
    }

    const [latestRate, oldestTx] = await Promise.all([
      db.fxRate.aggregate({ _max: { date: true } }),
      db.transaction.aggregate({ _min: { date: true } }),
    ]);
    const from = latestRate._max.date
      ? new Date(latestRate._max.date.getTime() - FX_OVERLAP_DAYS * DAY_MS)
      : (oldestTx._min.date ?? new Date());
    const rows = await fetchFxRates(currencies, from, new Date());
    if (rows.length === 0) {
      console.log("fx:           up to date");
      return;
    }

    await db.$transaction(
      rows.map((row) =>
        db.fxRate.upsert({
          where: { date_currency: { date: row.date, currency: row.currency } },
          create: row,
          update: { rate: row.rate },
        }),
      ),
    );

    console.log(`fx:           ${rows.length} rates synced (${currencies.join(", ")})`);
  } catch (error) {
    console.warn(`fx:           skipped — ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function syncAccounts(capturedAt: Date): Promise<Set<string>> {
  const akahu = akahuClient();
  const accounts = await akahu.accounts.list(akahuUserToken());

  for (const account of accounts) {
    const balance = account.balance;

    await db.account.upsert({
      where: { id: account._id },
      create: {
        id: account._id,
        name: account.name,
        status: account.status,
        type: account.type,
        formattedAccount: account.formatted_account ?? null,
        connectionId: account.connection._id,
        connectionName: account.connection.name,
        currency: balance?.currency ?? null,
        balanceCurrent: balance?.current ?? null,
        balanceAvailable: balance?.available ?? null,
        balanceLimit: balance?.limit ?? null,
        overdrawn: balance?.overdrawn ?? null,
        refreshedAt: account.refreshed?.balance ? new Date(account.refreshed.balance) : null,
      },
      update: {
        name: account.name,
        status: account.status,
        type: account.type,
        formattedAccount: account.formatted_account ?? null,
        connectionId: account.connection._id,
        connectionName: account.connection.name,
        currency: balance?.currency ?? null,
        balanceCurrent: balance?.current ?? null,
        balanceAvailable: balance?.available ?? null,
        balanceLimit: balance?.limit ?? null,
        overdrawn: balance?.overdrawn ?? null,
        refreshedAt: account.refreshed?.balance ? new Date(account.refreshed.balance) : null,
      },
    });

    // Akahu only exposes the *current* balance, so the history the dashboard
    // charts exists only because we append to it here.
    if (balance) {
      await db.balanceSnapshot.upsert({
        where: { accountId_capturedAt: { accountId: account._id, capturedAt } },
        create: {
          accountId: account._id,
          capturedAt,
          currency: balance.currency,
          current: balance.current,
          available: balance.available ?? null,
          limit: balance.limit ?? null,
        },
        update: {
          current: balance.current,
          available: balance.available ?? null,
          limit: balance.limit ?? null,
        },
      });
    }
  }

  console.log(`accounts:     ${accounts.length} synced`);
  return new Set(accounts.map((a) => a._id));
}

async function syncTransactions(args: Args, knownAccountIds: Set<string>): Promise<number> {
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
          categoryName: true,
          categorySource: true,
          merchantId: true,
          merchantName: true,
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
    const merchants = new Map<string, { id: string; name: string; website: string | null }>();

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
      const groups = enriched?.category?.groups;
      // Akahu categorises spending but leaves money-in uncategorised, so give an
      // otherwise-ungrouped inflow a default income group. "Other Income" is the
      // safe assumption — an inflow is only "Periodic Income" once a recurring
      // category names it (the server action then stamps `categoryGroup` from that
      // category's `groupName`). Outflows with no group stay null, as before.
      const categoryGroup =
        groups?.personal_finance?.name ??
        Object.values(groups ?? {})[0]?.name ??
        (tx.amount > 0 ? OTHER_INCOME_GROUP.name : null);

      // Only reference a merchant we can also store, so `merchantId` never points
      // at a Merchant row that was never created.
      const merchant = enriched?.merchant;
      const merchantId = merchant?._id && merchant.name ? merchant._id : null;
      const merchantName = merchant?.name ?? null;
      if (merchantId) {
        merchants.set(merchantId, {
          id: merchantId,
          name: merchant!.name,
          website: merchant!.website ?? null,
        });
      }

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
        merchantName,
        categoryId: enriched?.category?._id ?? null,
        categoryName: enriched?.category?.name ?? null,
        categoryGroup,
        particulars: enriched?.meta?.particulars ?? null,
        code: enriched?.meta?.code ?? null,
        reference: enriched?.meta?.reference ?? null,
        otherAccount: enriched?.meta?.other_account ?? null,
        cardSuffix: enriched?.meta?.card_suffix ?? null,
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
        delete update.categoryName;
        delete update.categoryGroup;
        const op = reconcileConflict(
          "category",
          tx._id,
          prior.categoryId,
          prior.categoryName,
          row.categoryId,
          row.categoryName,
          conflictByKey.get(`${tx._id}:category`),
        );
        if (op) conflictOps.push(op);
      }

      if (prior?.merchantSource === "user") {
        delete update.merchantId;
        delete update.merchantName;
        const op = reconcileConflict(
          "merchant",
          tx._id,
          prior.merchantId,
          prior.merchantName,
          row.merchantId,
          row.merchantName,
          conflictByKey.get(`${tx._id}:merchant`),
        );
        if (op) conflictOps.push(op);
      }

      synced++;
      txOps.push(
        db.transaction.upsert({
          where: { id: tx._id },
          create: { id: tx._id, ...row },
          update: update as Prisma.TransactionUpdateInput,
        }),
      );
    }

    // One SQLite write transaction per page keeps this fast and means a crash
    // mid-page can't leave a partially-applied page behind. Merchants lead so the
    // transactions that follow always find the row they point at; conflict ops
    // trail the transaction upserts they reference.
    await db.$transaction([
      ...[...merchants.values()].map((merchant) =>
        db.merchant.upsert({
          where: { id: merchant.id },
          create: merchant,
          update: { name: merchant.name, website: merchant.website },
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

  return synced;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const run = await db.syncRun.create({ data: {} });

  try {
    const capturedAt = startOfUtcDay(new Date());
    await syncCategories();
    const accountIds = await syncAccounts(capturedAt);
    const transactionsSynced = await syncTransactions(args, accountIds);
    await syncFxRates();

    await db.syncRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        accountsSynced: accountIds.size,
        transactionsSynced,
      },
    });

    console.log(`done (sync run #${run.id})`);
  } catch (error) {
    // Record the failure before rethrowing, otherwise a cron-driven sync that
    // keeps dying leaves no trace anywhere.
    await db.syncRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
