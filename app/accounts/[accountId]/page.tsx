import { notFound } from "next/navigation";
import { pageHref, paginate, Pagination, parsePage } from "@/ui/primitives/pagination";
import { StatList } from "@/ui/primitives/stat-list";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { getAccount, getAccountTransactions } from "@/lib/server/data";
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
  const basePath = `/accounts/${accountId}`;
  const totalPages = paginate(total, page, pageHref(basePath));

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <header className="mb-6">
        <h1 className="flex items-center gap-3 text-2xl font-semibold">
          {account.connection?.logo ? (
            <img
              src={account.connection.logo}
              alt=""
              className="h-8 w-8 rounded object-contain"
            />
          ) : null}
          {account.name}
        </h1>
        <p className="mt-1 text-sm opacity-60">
          {account.connection?.name ?? account.connectionId} · {account.type}
          {account.formattedAccount ? ` · ${account.formattedAccount}` : ""}
        </p>

        <StatList
          className="mt-4"
          stats={[
            { label: "Balance", value: formatMoney(account.balanceCurrent, account.currency) },
            { label: "Available", value: formatMoney(account.balanceAvailable, account.currency) },
            ...(account.balanceLimit !== null
              ? [{ label: "Limit", value: formatMoney(account.balanceLimit, account.currency) }]
              : []),
            { label: "Transactions", value: total.toLocaleString("en-NZ") },
          ]}
        />
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
          <Pagination basePath={basePath} page={page} totalPages={totalPages} />
        </>
      )}
    </main>
  );
}
