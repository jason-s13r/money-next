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

/** First run has no high-water mark, so pull this much history. */
const DEFAULT_LOOKBACK_DAYS = 5 * 365;

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

    // One SQLite write transaction per page keeps this fast and means a crash
    // mid-page can't leave a partially-applied page behind.
    await db.$transaction(
      page.items.flatMap((tx) => {
        // A transaction can outlive the account it belonged to; inserting it
        // would violate the foreign key, so drop it rather than fail the run.
        if (!knownAccountIds.has(tx._account)) {
          skipped++;
          return [];
        }

        const date = new Date(tx.date);
        if (!newest || date > newest) newest = date;

        const enriched = isEnriched(tx) ? tx : undefined;
        const groups = enriched?.category?.groups;
        const categoryGroup =
          groups?.personal_finance?.name ?? Object.values(groups ?? {})[0]?.name ?? null;

        const row = {
          accountId: tx._account,
          connectionId: tx._connection,
          date,
          description: tx.description,
          amount: tx.amount,
          balance: tx.balance ?? null,
          type: tx.type,
          hash: tx.hash ?? null,
          merchantId: enriched?.merchant?._id ?? null,
          merchantName: enriched?.merchant?.name ?? null,
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

        synced++;
        return [
          db.transaction.upsert({
            where: { id: tx._id },
            create: { id: tx._id, ...row },
            update: row,
          }),
        ];
      }),
    );

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
    const accountIds = await syncAccounts(capturedAt);
    const transactionsSynced = await syncTransactions(args, accountIds);

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
