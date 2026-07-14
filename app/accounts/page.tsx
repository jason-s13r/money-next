import { getAccounts, getLastSync } from "@/lib/server/data";
import { convert, getDisplayCurrency, loadRates } from "@/lib/server/currency";
import { formatMoney } from "@/lib/format";
import { AccountsTable } from "@/ui/accounts/accounts-table";
import { StatList } from "@/ui/primitives/stat-list";
import { SyncStatus } from "@/ui/chrome/sync-status";

export const metadata = {
  title: "Accounts",
};

export default async function AccountsPage() {
  const [accounts, lastSync] = await Promise.all([getAccounts(), getLastSync()]);

  const activeAccounts = accounts.filter((a) => a.status === "ACTIVE");
  const displayCurrency = await getDisplayCurrency();
  const rates = await loadRates([
    ...accounts.map((a) => a.currency),
    displayCurrency,
  ]);

  const withConverted = accounts.map((a) => ({
    ...a,
    connectionId: a.connectionId,
    connection: a.connection,
    transactionCount: a._count.transactions,
    balanceCurrentBase: convert(
      a.balanceCurrent ?? 0,
      a.currency,
      displayCurrency,
      rates,
    ),
    balanceAvailableBase: convert(
      a.balanceAvailable ?? 0,
      a.currency,
      displayCurrency,
      rates,
    ),
  }));

  const totalBalance = activeAccounts.reduce(
    (sum, a) => sum + (convert(a.balanceCurrent ?? 0, a.currency, displayCurrency, rates) ?? 0),
    0,
  );

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <SyncStatus lastSync={lastSync} />
      </header>


      <StatList
        className="mt-4 mb-4"
        stats={[
          {
            label: "Active accounts",
            value: activeAccounts.length.toLocaleString("en-NZ"),
          },
          {
            label: `Total balance (${displayCurrency})`,
            value: formatMoney(totalBalance, displayCurrency),
          },
        ]}
      />

      <AccountsTable accounts={withConverted} displayCurrency={displayCurrency} />
    </main>
  );
}
