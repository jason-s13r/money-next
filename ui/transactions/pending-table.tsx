import Link from "next/link";
import type { PendingTransactionItem } from "@/lib/server/queries/pending";
import { DEFAULT_CURRENCY as DISPLAY_CURRENCY, formatDate, formatMoney } from "@/lib/format";
import { positiveAmountClass } from "@/lib/ui/amount";

// Pending (authorised but unsettled) holds, shown atop the first page of a
// listing. Deliberately leaner than TransactionTable: pending rows have no stable
// id (so no detail link), no running balance, and no merchant/category — Akahu
// attaches only `meta` to them (see the PendingTransaction model). The whole block
// is muted and badged so it never reads as settled, spent money.

export function PendingTable({
  items,
  showAccount = true,
}: {
  items: PendingTransactionItem[];
  /** Off on an account's own page, where every row is that same account. */
  showAccount?: boolean;
}) {
  const th = "py-2 pr-4 font-medium";
  const thRight = "py-2 pl-4 text-right font-medium";
  const td = "py-2 pr-4";
  const tdNum = "py-2 pl-4 text-right font-mono tabular-nums";
  const link = "underline underline-offset-2";

  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium opacity-80">
        Pending
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-normal text-amber-700 dark:text-amber-400">
          {items.length} not yet settled
        </span>
      </h2>

      <table className="w-full border-collapse text-sm opacity-80">
        <thead>
          <tr className="border-b border-current/20 text-left">
            <th className={th}>Date</th>
            <th className={th}>Description</th>
            {showAccount ? <th className={th}>Account</th> : null}
            <th className={th}>Card</th>
            <th className={th}>Type</th>
            <th className={thRight}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((tx) => (
            <tr key={tx.id} className="border-b border-current/10">
              <td className={`${td} whitespace-nowrap opacity-60`}>{formatDate(tx.date)}</td>

              <td className={td}>{tx.description}</td>

              {showAccount ? (
                <td className={`${td} opacity-60`}>
                  <div className="flex items-center gap-2">
                    {tx.account.connection?.logo ? (
                      <img
                        src={tx.account.connection.logo}
                        alt=""
                        className="h-5 w-5 rounded object-contain"
                      />
                    ) : null}
                    <Link href={`/accounts/${tx.account.id}`} className={link}>
                      {tx.account.name}
                    </Link>
                  </div>
                </td>
              ) : null}

              <td className={`${td} opacity-60`}>
                {tx.cardSuffix ? (
                  <Link href={`/card/${tx.cardSuffix}`} className={link}>
                    ····{tx.cardSuffix}
                  </Link>
                ) : (
                  "—"
                )}
              </td>

              <td className={`${td} opacity-60`}>{tx.type}</td>

              <td className={`${tdNum} ${positiveAmountClass(tx.amount)}`}>
                {formatMoney(tx.amount, tx.account.currency)}
                {tx.account.currency &&
                tx.account.currency !== DISPLAY_CURRENCY &&
                tx.amountBase !== null ? (
                  <div className="text-xs font-normal opacity-60">
                    ≈ {formatMoney(tx.amountBase, DISPLAY_CURRENCY)}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
