import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Pagination, parsePage } from "@/app/_components/pagination";
import { TransactionTable } from "@/app/_components/transaction-table";
import {
  TRANSACTIONS_PER_PAGE,
  getAccount,
  getAccountTransactions,
} from "@/lib/data";
import { formatMoney } from "@/lib/format";

export async function generateMetadata(props: PageProps<"/accounts/[accountId]">) {
  const { accountId } = await props.params;
  const account = await getAccount(accountId);
  return { title: account?.name ?? "Account" };
}

export default async function AccountPage(props: PageProps<"/accounts/[accountId]">) {
  const { accountId } = await props.params;
  const page = parsePage((await props.searchParams).page);

  const account = await getAccount(accountId);
  if (!account) notFound();

  const { items, total } = await getAccountTransactions(accountId, page);
  const totalPages = Math.max(1, Math.ceil(total / TRANSACTIONS_PER_PAGE));

  // A `?page=` past the end would otherwise render an empty table with a "Page
  // 9 of 3" footer. Send the reader somewhere real instead.
  if (page > totalPages) redirect(`/accounts/${accountId}?page=${totalPages}`);

  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{account.name}</h1>
        <p className="mt-1 text-sm opacity-60">
          {account.connectionName} · {account.type}
          {account.formattedAccount ? ` · ${account.formattedAccount}` : ""}
        </p>

        <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-3 text-sm">
          <div>
            <dt className="opacity-60">Balance</dt>
            <dd className="font-mono tabular-nums">
              {formatMoney(account.balanceCurrent, account.currency)}
            </dd>
          </div>
          <div>
            <dt className="opacity-60">Available</dt>
            <dd className="font-mono tabular-nums">
              {formatMoney(account.balanceAvailable, account.currency)}
            </dd>
          </div>
          {account.balanceLimit !== null ? (
            <div>
              <dt className="opacity-60">Limit</dt>
              <dd className="font-mono tabular-nums">
                {formatMoney(account.balanceLimit, account.currency)}
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="opacity-60">Transactions</dt>
            <dd className="font-mono tabular-nums">{total.toLocaleString("en-NZ")}</dd>
          </div>
        </dl>
      </header>

      {total === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">
          No transactions for this account.
        </p>
      ) : (
        <>
          {/* Every row is this one account, so the Account column is dropped and
              the running Balance — meaningful only within a single account — added. */}
          <TransactionTable items={items} showAccount={false} showBalance />
          <Pagination basePath={`/accounts/${accountId}`} page={page} totalPages={totalPages} />
        </>
      )}
    </main>
  );
}
