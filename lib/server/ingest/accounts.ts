import type { Account as AkahuAccount, ConnectionInfo as AkahuConnection } from "akahu";
import type { AkahuContext } from "../akahu";
import { catalogDb, scopedBatch, type ScopedDb } from "../db";
import type { Prisma } from "../../generated/prisma/client";
import { archiveOps } from "./archive";
import { parseDate } from "./shared";

export async function fetchAccounts(akahu: AkahuContext): Promise<AkahuAccount[]> {
  return akahu.client.accounts.list(akahu.userToken);
}

function connectionRow(connection: AkahuConnection): Prisma.ConnectionCreateInput {
  return {
    id: connection._id,
    name: connection.name,
    logo: connection.logo ?? null,
    connectionType: connection.connection_type,
  };
}

/**
 * Mirror the institutions these accounts are held at. Unscoped on purpose: an
 * Akahu `conn_...` is institution-level, so ANZ is the same id for everybody.
 * That is a catalog, not tenant data.
 */
export async function syncConnections(accounts: AkahuAccount[]): Promise<void> {
  const seen = new Map<string, AkahuConnection>();
  for (const account of accounts) {
    const connection = account.connection;
    if (!seen.has(connection._id)) {
      seen.set(connection._id, connection);
    }
  }

  // One pipelined transaction rather than a `for…of` of awaits or a `Promise.all`
  // fan-out. The loop cost a round trip per institution; the fan-out would issue
  // every upsert at once and hold a pool connection for each, which for a sync
  // that also has accounts and pages of transactions to write is a burst the rest
  // of the run then queues behind. A batch is one connection and one round trip,
  // and it commits or it doesn't.
  await catalogDb.$transaction(
    [...seen.values()].map((connection) =>
      catalogDb.connection.upsert({
        where: { id: connection._id },
        create: connectionRow(connection),
        update: connectionRow(connection),
      }),
    ),
  );

  console.log(`connections:  ${seen.size} synced`);
}

export async function syncAccounts(
  db: ScopedDb,
  link: { id: string; workspaceId: string },
  accounts: AkahuAccount[],
  capturedAt: Date,
  runId: string,
  superseded: ReadonlySet<string>,
): Promise<number> {
  // Built up front and committed as one batch, the way `syncTransactions` commits
  // a page: an account and the balance snapshot taken from it are the same fact
  // recorded twice, so a run that writes one without the other leaves the
  // dashboard charting a balance history that disagrees with the account beside
  // it. `scopedBatch` also sets the RLS variable once at the head of the
  // transaction, which is why the ops are built from the scoped client but not
  // awaited here.
  const ops: Prisma.PrismaPromise<unknown>[] = [];

  // Everything Akahu said, before the projection below throws most of it away.
  // Accounts *and* the institutions embedded in them: `syncConnections` mirrors
  // those through the unscoped catalog client, which by design has no workspace
  // to file an archive row under, so the copy is taken here where one exists.
  ops.push(
    ...archiveOps(
      db,
      "account",
      accounts.map((account) => ({ id: account._id, payload: account })),
      runId,
    ),
    ...archiveOps(
      db,
      "connection",
      [...new Map(accounts.map((a) => [a.connection._id, a.connection])).entries()].map(
        ([id, connection]) => ({ id, payload: connection }),
      ),
      runId,
    ),
  );

  let skipped = 0;

  for (const account of accounts) {
    // A superseded account is a tombstone: its transactions have been merged
    // into the survivor and its balance is deliberately frozen where the merge
    // left it. Writing either back would resurrect the double count the merge
    // removed. Akahu stops returning a migrated account, so in the case this was
    // built for we never get here — but nothing guarantees that, and the cost of
    // being wrong is silently wrong numbers on the dashboard.
    //
    // The archive above is *not* skipped: knowing what Akahu still says about an
    // account we have retired is exactly the sort of thing that table is for.
    if (superseded.has(account._id)) {
      skipped++;
      continue;
    }

    const balance = account.balance;
    const attributes = new Set(account.attributes);
    const refreshed = account.refreshed;

    // The shared shape of a create and an update: every field except `id`,
    // `workspaceId`, and `bankLinkId` (which only the create needs). Extracting
    // it means a new field can't drift into one side and not the other.
    //
    // `displayName` is absent on purpose, and must stay absent. It is the one
    // account column a person writes rather than Akahu, so listing it here — even
    // as `account.name` — would overwrite a household's rename on the next sync.
    const accountAttrs = {
      name: account.name,
      status: account.status,
      type: account.type,
      formattedAccount: account.formatted_account ?? null,
      connectionId: account.connection._id,
      holder: account.meta?.holder ?? null,
      hasTransactions: attributes.has("TRANSACTIONS"),
      canReceivePayments: attributes.has("PAYMENT_TO"),
      canInitiatePayments: attributes.has("PAYMENT_FROM"),
      currency: balance?.currency ?? null,
      balanceCurrent: balance?.current ?? null,
      balanceAvailable: balance?.available ?? null,
      balanceLimit: balance?.limit ?? null,
      overdrawn: balance?.overdrawn ?? null,
      refreshedBalance: parseDate(refreshed?.balance),
      refreshedMeta: parseDate(refreshed?.meta),
      refreshedTransactions: parseDate(refreshed?.transactions),
      refreshedParty: parseDate(refreshed?.party),
      refreshedAt: refreshed?.balance ? new Date(refreshed.balance) : null,
      // Akahu's, so it belongs in the mirrored set and not beside `displayName`
      // below: if Akahu revises which account this one succeeded, it is right.
      migratedFromId: account._migrated ?? null,
    };

    ops.push(
      db.account.upsert({
        where: { id: account._id },
        create: {
          id: account._id,
          workspaceId: db.$workspaceId,
          bankLinkId: link.id,
          ...accountAttrs,
        },
        update: accountAttrs,
      }),
    );

    // Akahu only exposes the *current* balance, so the history the dashboard
    // charts exists only because we append to it here. Pushed after the account
    // upsert because a batch runs in order, and the snapshot's foreign key needs
    // the account row to exist first on the very first sync.
    if (balance) {
      ops.push(
        db.balanceSnapshot.upsert({
          where: { accountId_capturedAt: { accountId: account._id, capturedAt } },
          create: {
            workspaceId: db.$workspaceId,
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
        }),
      );
    }
  }

  await scopedBatch(db, ops);

  // Returned, not recomputed by the caller from `accounts.length`: the run record
  // and this line have to be the same number, and they stopped being the same
  // number the moment a returned account could be skipped.
  const synced = accounts.length - skipped;
  console.log(
    `accounts:     ${synced} synced` +
      (skipped > 0 ? ` (${skipped} skipped — superseded)` : ""),
  );
  return synced;
}
