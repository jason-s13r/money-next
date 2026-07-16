/**
 * One-time import of the old SQLite database into Postgres.
 *
 *   pnpm db:import                  # from ./money.db
 *   pnpm db:import --from other.db  # from somewhere else
 *   pnpm db:import --force          # allow importing into a non-empty database
 *
 * This exists because `prisma migrate` cannot carry data across providers, and
 * because two column types change on the way: money becomes `Decimal` and the
 * SQLite text timestamps become `timestamptz`.
 *
 * It is deliberately a throwaway: once the Postgres database is the source of
 * truth this script and the old `money.db` can both be deleted. It is kept in
 * the repo only so the import is reproducible and reviewable.
 *
 * Reads with Node's built-in `node:sqlite`, so importing needs no SQLite
 * dependency in package.json — the point of dropping better-sqlite3 was to get
 * a native module out of the image, and reinstalling one to read the old file
 * would defeat that.
 */
import { DatabaseSync } from "node:sqlite";
import { db } from "../lib/server/db";

type Row = Record<string, unknown>;

/** SQLite stores our DateTimes as ISO-8601 text; Postgres wants a real instant. */
function date(value: unknown): Date | null {
  if (value == null) return null;
  const parsed = new Date(value as string);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`unparseable date: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** Non-null DateTime columns: same as `date`, but the null is a bug, not a value. */
function required(value: unknown, column: string): Date {
  const parsed = date(value);
  if (parsed === null) throw new Error(`${column} is null but the column is required`);
  return parsed;
}

/** SQLite has no boolean type — it stores 0/1 integers. */
function bool(value: unknown): boolean | null {
  return value == null ? null : Boolean(value);
}

function main() {
  const argv = process.argv.slice(2);
  const fromFlag = argv.indexOf("--from");
  const source = fromFlag !== -1 ? argv[fromFlag + 1] : "./money.db";
  const force = argv.includes("--force");

  return run(source, force);
}

async function run(source: string, force: boolean) {
  const sqlite = new DatabaseSync(source, { readOnly: true });
  const all = (table: string): Row[] =>
    sqlite.prepare(`select * from "${table}"`).all() as Row[];

  // Importing into a database that already holds rows would silently double
  // them, and this runs against the database that is about to become the only
  // copy of the data. Refuse by default.
  const existing = await db.transaction.count();
  if (existing > 0 && !force) {
    throw new Error(
      `target already has ${existing} transactions. Re-running would duplicate rows. ` +
        `Use --force only if you know the target should be added to.`,
    );
  }

  console.log(`importing from ${source}\n`);

  // Insert order follows the foreign keys: a Transaction cannot land before the
  // Account, Merchant, Category, CategoryGroup and TransferGroup it points at.
  const counts: Record<string, number> = {};
  const track = async (name: string, fn: () => Promise<{ count: number }>) => {
    const { count } = await fn();
    counts[name] = count;
    console.log(`  ${name.padEnd(20)} ${count}`);
  };

  await track("Connection", () =>
    db.connection.createMany({
      data: all("Connection").map((r) => ({
        id: r.id as string,
        name: r.name as string,
        logo: r.logo as string | null,
        connectionType: r.connectionType as string,
        syncedAt: required(r.syncedAt, "Connection.syncedAt"),
      })),
    }),
  );

  await track("CategoryGroup", () =>
    db.categoryGroup.createMany({
      data: all("CategoryGroup").map((r) => ({
        id: r.id as string,
        name: r.name as string,
      })),
    }),
  );

  await track("Category", () =>
    db.category.createMany({
      data: all("Category").map((r) => ({
        id: r.id as string,
        name: r.name as string,
        direction: r.direction as string,
        groupId: r.groupId as string | null,
        syncedAt: required(r.syncedAt, "Category.syncedAt"),
      })),
    }),
  );

  await track("Merchant", () =>
    db.merchant.createMany({
      data: all("Merchant").map((r) => ({
        id: r.id as string,
        name: r.name as string,
        website: r.website as string | null,
        logo: r.logo as string | null,
      })),
    }),
  );

  await track("TransferGroup", () =>
    db.transferGroup.createMany({
      data: all("TransferGroup").map((r) => ({
        id: r.id as number,
        createdAt: required(r.createdAt, "TransferGroup.createdAt"),
      })),
    }),
  );

  await track("Account", () =>
    db.account.createMany({
      data: all("Account").map((r) => ({
        id: r.id as string,
        name: r.name as string,
        status: r.status as string,
        type: r.type as string,
        formattedAccount: r.formattedAccount as string | null,
        connectionId: r.connectionId as string,
        holder: r.holder as string | null,
        hasTransactions: bool(r.hasTransactions) ?? false,
        canReceivePayments: bool(r.canReceivePayments) ?? false,
        canInitiatePayments: bool(r.canInitiatePayments) ?? false,
        currency: r.currency as string | null,
        balanceCurrent: r.balanceCurrent as number | null,
        balanceAvailable: r.balanceAvailable as number | null,
        balanceLimit: r.balanceLimit as number | null,
        overdrawn: bool(r.overdrawn),
        refreshedBalance: date(r.refreshedBalance),
        refreshedMeta: date(r.refreshedMeta),
        refreshedTransactions: date(r.refreshedTransactions),
        refreshedParty: date(r.refreshedParty),
        refreshedAt: date(r.refreshedAt),
        syncedAt: required(r.syncedAt, "Account.syncedAt"),
      })),
    }),
  );

  // The big one. Chunked so the driver is not handed a single 4k-row statement.
  const transactions = all("Transaction").map((r) => ({
    id: r.id as string,
    accountId: r.accountId as string,
    connectionId: r.connectionId as string,
    date: required(r.date, "Transaction.date"),
    description: r.description as string,
    amount: r.amount as number,
    balance: r.balance as number | null,
    type: r.type as string,
    hash: r.hash as string | null,
    merchantId: r.merchantId as string | null,
    categoryId: r.categoryId as string | null,
    categoryGroupId: r.categoryGroupId as string | null,
    categorySource: r.categorySource as string,
    merchantSource: r.merchantSource as string,
    particulars: r.particulars as string | null,
    code: r.code as string | null,
    reference: r.reference as string | null,
    otherAccount: r.otherAccount as string | null,
    cardSuffix: r.cardSuffix as string | null,
    conversionAmount: r.conversionAmount as number | null,
    conversionCurrency: r.conversionCurrency as string | null,
    conversionRate: r.conversionRate as number | null,
    logo: r.logo as string | null,
    transferGroupId: r.transferGroupId as number | null,
    createdAt: date(r.createdAt),
    updatedAt: date(r.updatedAt),
    syncedAt: required(r.syncedAt, "Transaction.syncedAt"),
  }));

  let written = 0;
  for (let i = 0; i < transactions.length; i += 500) {
    const chunk = transactions.slice(i, i + 500);
    const { count } = await db.transaction.createMany({ data: chunk });
    written += count;
  }
  counts.Transaction = written;
  console.log(`  ${"Transaction".padEnd(20)} ${written}`);

  await track("PendingTransaction", () =>
    db.pendingTransaction.createMany({
      data: all("PendingTransaction").map((r) => ({
        id: r.id as number,
        accountId: r.accountId as string,
        connectionId: r.connectionId as string,
        date: required(r.date, "PendingTransaction.date"),
        description: r.description as string,
        amount: r.amount as number,
        type: r.type as string,
        akahuUpdatedAt: required(r.akahuUpdatedAt, "PendingTransaction.akahuUpdatedAt"),
        particulars: r.particulars as string | null,
        code: r.code as string | null,
        reference: r.reference as string | null,
        otherAccount: r.otherAccount as string | null,
        cardSuffix: r.cardSuffix as string | null,
        conversionAmount: r.conversionAmount as number | null,
        conversionCurrency: r.conversionCurrency as string | null,
        conversionRate: r.conversionRate as number | null,
        syncedAt: required(r.syncedAt, "PendingTransaction.syncedAt"),
      })),
    }),
  );

  await track("BalanceSnapshot", () =>
    db.balanceSnapshot.createMany({
      data: all("BalanceSnapshot").map((r) => ({
        id: r.id as number,
        accountId: r.accountId as string,
        currency: r.currency as string | null,
        current: r.current as number,
        available: r.available as number | null,
        limit: r.limit as number | null,
        capturedAt: required(r.capturedAt, "BalanceSnapshot.capturedAt"),
      })),
    }),
  );

  await track("TransactionConflict", () =>
    db.transactionConflict.createMany({
      data: all("TransactionConflict").map((r) => ({
        id: r.id as number,
        transactionId: r.transactionId as string,
        field: r.field as string,
        userValueId: r.userValueId as string | null,
        userValueLabel: r.userValueLabel as string | null,
        akahuValueId: r.akahuValueId as string | null,
        akahuValueLabel: r.akahuValueLabel as string | null,
        status: r.status as string,
        detectedAt: required(r.detectedAt, "TransactionConflict.detectedAt"),
        updatedAt: required(r.updatedAt, "TransactionConflict.updatedAt"),
      })),
    }),
  );

  await track("FxRate", () =>
    db.fxRate.createMany({
      data: all("FxRate").map((r) => ({
        date: required(r.date, "FxRate.date"),
        base: r.base as string,
        currency: r.currency as string,
        rate: r.rate as number,
      })),
    }),
  );

  await track("SyncState", () =>
    db.syncState.createMany({
      data: all("SyncState").map((r) => ({
        id: r.id as string,
        lastTransactionDate: date(r.lastTransactionDate),
        updatedAt: required(r.updatedAt, "SyncState.updatedAt"),
      })),
    }),
  );

  await track("SyncRun", () =>
    db.syncRun.createMany({
      data: all("SyncRun").map((r) => ({
        id: r.id as number,
        startedAt: required(r.startedAt, "SyncRun.startedAt"),
        finishedAt: date(r.finishedAt),
        status: r.status as string,
        accountsSynced: r.accountsSynced as number,
        transactionsSynced: r.transactionsSynced as number,
        error: r.error as string | null,
      })),
    }),
  );

  await track("RuleDocument", () =>
    db.ruleDocument.createMany({
      data: all("RuleDocument").map((r) => ({
        id: r.id as number,
        name: r.name as string,
        slug: r.slug as string,
        content: r.content as string,
        active: bool(r.active) ?? false,
        createdAt: required(r.createdAt, "RuleDocument.createdAt"),
        updatedAt: required(r.updatedAt, "RuleDocument.updatedAt"),
      })),
    }),
  );

  await track("RuleRun", () =>
    db.ruleRun.createMany({
      data: all("RuleRun").map((r) => ({
        id: r.id as number,
        startedAt: required(r.startedAt, "RuleRun.startedAt"),
        finishedAt: date(r.finishedAt),
        trigger: r.trigger as string,
        status: r.status as string,
        evaluated: r.evaluated as number,
        categorised: r.categorised as number,
        merchantsSet: r.merchantsSet as number,
        transfersLinked: r.transfersLinked as number,
        errors: r.errors as number,
        error: r.error as string | null,
      })),
    }),
  );

  await track("RuleApplication", () =>
    db.ruleApplication.createMany({
      data: all("RuleApplication").map((r) => ({
        id: r.id as number,
        runId: r.runId as number,
        transactionId: r.transactionId as string,
        field: r.field as string,
        fromLabel: r.fromLabel as string | null,
        toLabel: r.toLabel as string | null,
        createdAt: required(r.createdAt, "RuleApplication.createdAt"),
      })),
    }),
  );

  sqlite.close();

  // Every autoincrement id above was inserted explicitly, to keep the references
  // that point at it (Transaction.transferGroupId, RuleApplication.runId). That
  // leaves each sequence still sitting at 1, so the next insert Postgres
  // generates would collide with row 1. Fast-forward them past the imported ids.
  console.log("\nresetting sequences");
  const sequenced = [
    "TransferGroup",
    "PendingTransaction",
    "BalanceSnapshot",
    "TransactionConflict",
    "SyncRun",
    "RuleDocument",
    "RuleRun",
    "RuleApplication",
  ];
  for (const table of sequenced) {
    // `is_called = false` so the next value returned is exactly `max(id) + 1`,
    // and coalesce covers an empty table, where the sequence must stay at 1.
    const next = await db.$queryRawUnsafe<{ value: bigint }[]>(
      `select setval(pg_get_serial_sequence('"${table}"', 'id'),
                     coalesce((select max(id) from "${table}"), 0) + 1,
                     false) as value`,
    );
    console.log(`  ${table.padEnd(20)} next id = ${next[0].value}`);
  }

  console.log("\nimported:");
  console.table(counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
