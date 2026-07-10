import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Pagination, parsePage } from "@/app/_components/pagination";
import {
  TRANSACTIONS_PER_PAGE,
  getAccount,
  getAccountTransactions,
} from "@/lib/data";
import { formatDate, formatMoney } from "@/lib/format";
import { slugify } from "@/lib/slug";

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
      <nav className="mb-4 text-sm">
        <Link href="/accounts" className="underline underline-offset-2 opacity-60">
          ← Accounts
        </Link>
      </nav>

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

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-current/20 text-left">
            <th className="py-2 pr-4 font-medium">Date</th>
            <th className="py-2 pr-4 font-medium">Description</th>
            <th className="py-2 pr-4 font-medium">Group</th>
            <th className="py-2 pr-4 font-medium">Category</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pl-4 text-right font-medium">Amount</th>
            <th className="py-2 pl-4 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody>
          {items.map((tx) => (
            <tr key={tx.id} className="border-b border-current/10">
              <td className="py-2 pr-4 whitespace-nowrap opacity-60">
                <Link
                  href={`/transactions/${tx.id}`}
                  className="underline underline-offset-2"
                  >
                  {formatDate(tx.date)}
                </Link>
              </td>
              <td className="py-2 pr-4">
                {tx.merchantName ? (
                  <Link
                    href={`/merchants/${slugify(tx.merchantName)}`}
                    className="underline underline-offset-2"
                  >
                    {tx.merchantName}
                  </Link>
                ) : (
                  tx.description
                )}
              </td>
              <td className="py-2 pr-4 opacity-60">
                {tx.categoryGroup ? (
                  <Link
                    href={`/categories/${slugify(tx.categoryGroup)}`}
                    className="underline underline-offset-2"
                  >
                    {tx.categoryGroup}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
              <td className="py-2 pr-4 opacity-60">
                {tx.categoryGroup && tx.categoryName ? (
                  <Link
                    href={`/categories/${slugify(tx.categoryGroup)}/${slugify(tx.categoryName)}`}
                    className="underline underline-offset-2"
                  >
                    {tx.categoryName}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
              <td className="py-2 pr-4 opacity-60">{tx.type}</td>
              <td
                className={`py-2 pl-4 text-right font-mono tabular-nums ${
                  tx.amount > 0 ? "text-green-600 dark:text-green-400" : ""
                }`}
              >
                {formatMoney(tx.amount, account.currency)}
              </td>
              <td className="py-2 pl-4 text-right font-mono tabular-nums opacity-60">
                {formatMoney(tx.balance, account.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {total === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">
          No transactions for this account.
        </p>
      ) : (
        <Pagination basePath={`/accounts/${accountId}`} page={page} totalPages={totalPages} />
      )}
    </main>
  );
}
