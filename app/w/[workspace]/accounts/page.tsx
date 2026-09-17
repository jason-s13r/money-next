import { getAccounts } from "@/lib/server/queries/accounts";
import { convert, getDisplayCurrency, loadRates } from "@/lib/server/currency";
import { formatMoney } from "@/lib/format";
import { AccountsTable } from "@/ui/accounts/accounts-table";
import { StatList } from "@/ui/primitives/stat-list";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata = {
  title: "Accounts",
};

export default async function AccountsPage() {
  const accounts = await getAccounts();

  // `status` alone is not enough any more. Akahu stops returning an account it
  // has migrated, which freezes its status at ACTIVE for good — so a superseded
  // account would keep its stale balance in both figures below, which is the
  // double count the merge exists to remove. See lib/server/accounts/scope.ts.
  const activeAccounts = accounts.filter(
    (a) => a.status === "ACTIVE" && !a.supersededById,
  );
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
    pendingCount: a._count.pending,
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
      <h1 className="sr-only">Accounts</h1>

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
