import type { Account as AkahuAccount, ConnectionInfo as AkahuConnection } from "akahu";
import { db } from "../db";
import type { Prisma } from "../../generated/prisma/client";
import { parseDate } from "./shared";

export async function fetchAccounts(): Promise<AkahuAccount[]> {
  const { akahuClient, akahuUserToken } = await import("../akahu");
  const akahu = akahuClient();
  return akahu.accounts.list(akahuUserToken());
}

function connectionRow(connection: AkahuConnection): Prisma.ConnectionCreateInput {
  return {
    id: connection._id,
    name: connection.name,
    logo: connection.logo ?? null,
    connectionType: connection.connection_type,
  };
}

export async function syncConnections(accounts: AkahuAccount[]): Promise<void> {
  const seen = new Map<string, AkahuConnection>();
  for (const account of accounts) {
    const connection = account.connection;
    if (!seen.has(connection._id)) {
      seen.set(connection._id, connection);
    }
  }

  for (const connection of seen.values()) {
    await db.connection.upsert({
      where: { id: connection._id },
      create: connectionRow(connection),
      update: connectionRow(connection),
    });
  }

  console.log(`connections:  ${seen.size} synced`);
}

export async function syncAccounts(accounts: AkahuAccount[], capturedAt: Date): Promise<void> {
  for (const account of accounts) {
    const balance = account.balance;
    const attributes = new Set(account.attributes);
    const refreshed = account.refreshed;

    await db.account.upsert({
      where: { id: account._id },
      create: {
        id: account._id,
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
      },
      update: {
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
}
