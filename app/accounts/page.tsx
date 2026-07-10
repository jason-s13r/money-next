import Link from "next/link";
import { getAccounts, getLastSync } from "@/lib/data";
import { formatDateTime, formatMoney } from "@/lib/format";

export const metadata = {
  title: "Accounts",
};

export default async function AccountsPage() {
  const [accounts, lastSync] = await Promise.all([getAccounts(), getLastSync()]);

  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <p className="mt-1 text-sm opacity-60">
          {lastSync
            ? `Last synced ${formatDateTime(lastSync.finishedAt)}`
            : "Never synced — run `pnpm db:sync`"}
        </p>
      </header>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-current/20 text-left">
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 font-medium">Bank</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pl-4 text-right font-medium">Balance</th>
            <th className="py-2 pl-4 text-right font-medium">Available</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.id} className="border-b border-current/10">
              <td className="py-2 pr-4">
                <Link
                  href={`/accounts/${account.id}`}
                  className="underline underline-offset-2"
                >
                  {account.name}
                </Link>
                {account.formattedAccount ? (
                  <span className="ml-2 font-mono text-xs opacity-50">
                    {account.formattedAccount}
                  </span>
                ) : null}
              </td>
              <td className="py-2 pr-4">{account.connectionName}</td>
              <td className="py-2 pr-4">{account.type}</td>
              <td className="py-2 pr-4">
                <span className={account.status === "ACTIVE" ? "" : "opacity-50"}>
                  {account.status}
                </span>
              </td>
              <td className="py-2 pl-4 text-right font-mono tabular-nums">
                {formatMoney(account.balanceCurrent, account.currency)}
              </td>
              <td className="py-2 pl-4 text-right font-mono tabular-nums">
                {formatMoney(account.balanceAvailable, account.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {accounts.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">
          No accounts yet. Run `pnpm db:sync`.
        </p>
      ) : null}
    </main>
  );
}
