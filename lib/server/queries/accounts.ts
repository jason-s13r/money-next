import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { getDb } from "../db/request";
import { accountMoney, moneySum } from "../money";
import { accountLabel } from "@/lib/account-name";

// Account reads, and the net-worth roll-up across them. Like the rest of the read
// layer these touch only the database (never Akahu) and await `connection()` first,
// so a query can't resolve during prerendering and bake a stale balance into
// static HTML. Balances are converted out of `Decimal` here (see lib/server/money.ts).

export async function getAccounts() {
  await connection();
  const db = await getDb();
  const rows = await db.account.findMany({
    orderBy: [{ status: "asc" }, { connection: { name: "asc" } }, { name: "asc" }],
    include: {
      connection: { select: { id: true, name: true, logo: true } },
      _count: { select: { transactions: true, pending: true } },
    },
  });
  const accounts = rows.map(accountMoney);

  // Prisma can't order by a relation count, so sort in memory: active status
  // first, then accounts with any transactions ahead of empty ones, then
  // connection and name. Sorting here rather than in the query is also what lets
  // the name leg follow the *displayed* label — a renamed account sorts where the
  // reader sees it, not where the provider's wording would have put it.
  return accounts.toSorted((a, b) => {
    if (a.status !== b.status) return a.status.localeCompare(b.status);
    const aHasTx = a._count.transactions > 0 ? 1 : 0;
    const bHasTx = b._count.transactions > 0 ? 1 : 0;
    if (aHasTx !== bHasTx) return bHasTx - aHasTx;
    const byConnection = a.connection.name.localeCompare(b.connection.name);
    if (byConnection !== 0) return byConnection;
    return accountLabel(a).localeCompare(accountLabel(b));
  });
}

// `generateMetadata` and the page component both need the record. Prisma isn't
// `fetch`, so it gets no automatic request memoization — `cache` supplies it and
// the second caller reuses the first query.
export const getAccount = cache(async (id: string) => {
  await connection();
  const db = await getDb();
  const account = await db.account.findUnique({
    where: { id },
    include: { connection: { select: { id: true, name: true, logo: true } } },
  });
  return account && accountMoney(account);
});

/** Sum of current balances across active accounts, grouped by currency. */
export async function getNetWorth() {
  await connection();
  const db = await getDb();
  const grouped = await db.account.groupBy({
    by: ["currency"],
    where: { status: "ACTIVE", currency: { not: null } },
    _sum: { balanceCurrent: true },
  });

  // Grouped by currency, so each subtotal adds up like-for-like — and Postgres
  // sums the Decimal column exactly before it becomes a number here.
  return grouped.map((row) => ({
    currency: row.currency!,
    total: moneySum(row._sum.balanceCurrent),
  }));
}
