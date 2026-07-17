import { Link } from "@/ui/chrome/workspace-context";
import { formatMoney } from "@/lib/format";

// The accounts listing table. Structurally typed on just the fields it shows, so
// it stays a presentational component independent of the data layer.

type AccountRow = {
  id: string;
  name: string;
  formattedAccount: string | null;
  connectionId: string;
  connection?: { name: string; logo: string | null } | null;
  type: string;
  status: string;
  balanceCurrent: number | null;
  balanceAvailable: number | null;
  balanceCurrentBase: number | null;
  balanceAvailableBase: number | null;
  balanceLimit: number | null;
  overdrawn: boolean | null;
  currency: string | null;
  refreshedAt: Date | null;
  transactionCount: number;
  pendingCount: number;
};

function amountClass(amount: number | null) {
  if (amount === null) return "";
  if (amount > 0) return "text-status-good";
  if (amount < 0) return "text-status-critical";
  return "";
}

export function AccountsTable({
  accounts,
  displayCurrency,
}: {
  accounts: AccountRow[];
  displayCurrency: string;
}) {
  if (accounts.length === 0) {
    return (
      <p className="py-8 text-center text-sm opacity-60">
        No accounts yet. Run `pnpm db:sync`.
      </p>
    );
  }

  const th = "py-2 pr-4 font-medium";
  const thRight = "py-2 pl-4 text-right font-medium";
  const td = "py-2 pr-4";
  const tdNum = "py-2 pl-4 text-right font-mono tabular-nums";
  const tdNumProminent = "py-2 pl-4 text-right font-mono text-base tabular-nums font-medium";
  const link = "underline underline-offset-2";

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-current/20 text-left">
          <th className={th}>Bank</th>
          <th className={th}>Name</th>
          <th className={`${thRight} text-right`}>Transactions</th>
          <th className={thRight}>Balance</th>
          <th className={thRight}>Available</th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((account) => (
          <tr key={account.id} className="border-b border-current/10">
            <td className={`${td} opacity-60`}>
              <div className="flex items-center gap-2">
                {account.connection?.logo ? (
                  <img
                    src={account.connection.logo}
                    alt=""
                    className="h-5 w-5 rounded object-contain"
                  />
                ) : null}
                {account.connection?.name ?? account.connectionId}
              </div>
            </td>
            <td className={td}>
              <Link href={`/accounts/${account.id}`} className={link}>
                {account.name}
              </Link>
              <div className="font-mono text-xs opacity-50">
                <span
                  className={
                    account.status === "ACTIVE"
                      ? "text-status-good"
                      : "opacity-50"
                  }
                >
                  {account.status}
                </span>
                {' '}
                <span>{account.type}</span>
                {' '}
                <span className="font-mono tabular-nums">{account.formattedAccount}</span>
              </div>
            </td>
            <td className={`${tdNum} opacity-70`}>
              {account.transactionCount.toLocaleString("en-NZ")}
              {/* Pending holds not yet in the settled count above. */}
              {account.pendingCount > 0 ? (
                <div className="text-xs font-normal text-amber-700 dark:text-amber-400">
                  {account.pendingCount.toLocaleString("en-NZ")} pending
                </div>
              ) : null}
            </td>
            <td className={`${tdNum} opacity-70`}>
              {account.overdrawn ? (
                <span
                  title="Overdrawn"
                  className="ml-1.5 text-status-critical"
                >
                  ●
                </span>
              ) : null}
              {' '}
              <span className={amountClass(account.balanceCurrent)}>
                {formatMoney(account.balanceCurrent, account.currency)}
              </span>
              {account.balanceCurrentBase !== null &&
              account.currency &&
              account.currency !== displayCurrency ? (
                <div className="font-mono text-xs opacity-60">
                  ≈ {formatMoney(account.balanceCurrentBase, displayCurrency)}
                </div>
              ) : null}
            </td>
            <td className={tdNumProminent}>
              <span className={amountClass(account.balanceAvailable)}>
                {formatMoney(account.balanceAvailable, account.currency)}
              </span>
              {account.balanceAvailableBase !== null &&
              account.currency &&
              account.currency !== displayCurrency ? (
                <div className="font-mono text-xs opacity-60">
                  ≈ {formatMoney(account.balanceAvailableBase, displayCurrency)}
                </div>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
