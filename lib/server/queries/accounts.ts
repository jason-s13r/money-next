import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { db } from "../db";

// Account reads, and the net-worth roll-up across them. Like the rest of the read
// layer these touch only SQLite (never Akahu) and await `connection()` first, so a
// query can't resolve during prerendering and bake a stale balance into static HTML.

export async function getAccounts() {
  await connection();
  const accounts = await db.account.findMany({
    orderBy: [{ status: "asc" }, { connection: { name: "asc" } }, { name: "asc" }],
    include: {
      connection: { select: { id: true, name: true, logo: true } },
      _count: { select: { transactions: true, pending: true } },
    },
  });

  // Prisma can't order by a relation count on SQLite, so sort in memory:
  // active status first, then accounts with any transactions ahead of empty
  // ones, then connection and name.
  return accounts.toSorted((a, b) => {
    if (a.status !== b.status) return a.status.localeCompare(b.status);
    const aHasTx = a._count.transactions > 0 ? 1 : 0;
    const bHasTx = b._count.transactions > 0 ? 1 : 0;
    if (aHasTx !== bHasTx) return bHasTx - aHasTx;
    const byConnection = a.connection.name.localeCompare(b.connection.name);
    if (byConnection !== 0) return byConnection;
    return a.name.localeCompare(b.name);
  });
}

// `generateMetadata` and the page component both need the record. Prisma isn't
// `fetch`, so it gets no automatic request memoization — `cache` supplies it and
// the second caller reuses the first query.
export const getAccount = cache(async (id: string) => {
  await connection();
  return db.account.findUnique({
    where: { id },
    include: { connection: { select: { id: true, name: true, logo: true } } },
  });
});

/** Sum of current balances across active accounts, grouped by currency. */
export async function getNetWorth() {
  await connection();
  const grouped = await db.account.groupBy({
    by: ["currency"],
    where: { status: "ACTIVE", currency: { not: null } },
    _sum: { balanceCurrent: true },
  });

  return grouped.map((row) => ({
    currency: row.currency!,
    total: row._sum.balanceCurrent ?? 0,
  }));
}
