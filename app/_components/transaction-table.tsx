import Link from "next/link";
import type { TransactionListItem } from "@/lib/data";
import { formatDate, formatMoney } from "@/lib/format";
import { slugify } from "@/lib/slug";

// The list every "what is in this bucket?" page renders. The bucket itself is
// the page's subject, so each page tells the table which column merely repeats
// the heading — a category page whose Category column reads the same 50 times
// is 50 rows of noise.

export function TransactionTable({
  items,
  showCategory = true,
  linkMerchant = true,
}: {
  items: TransactionListItem[];
  showCategory?: boolean;
  /** Off on a merchant's own page, where every row would link back to itself. */
  linkMerchant?: boolean;
}) {
  const th = "py-2 pr-4 font-medium";
  const td = "py-2 pr-4";
  const link = "underline underline-offset-2";

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-current/20 text-left">
          <th className={th}>Date</th>
          <th className={th}>Description</th>
          <th className={th}>Account</th>
          {showCategory ? <th className={th}>Category</th> : null}
          <th className={th}>Type</th>
          <th className="py-2 pl-4 text-right font-medium">Amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map((tx) => (
          <tr key={tx.id} className="border-b border-current/10">
            <td className={`${td} whitespace-nowrap opacity-60`}>
              <Link href={`/transactions/${tx.id}`} className={link}>
                {formatDate(tx.date)}
              </Link>
            </td>

            <td className={td}>
              {tx.merchantName && linkMerchant ? (
                <Link href={`/merchants/${slugify(tx.merchantName)}`} className={link}>
                  {tx.merchantName}
                </Link>
              ) : (
                (tx.merchantName ?? tx.description)
              )}
            </td>

            <td className={`${td} opacity-60`}>
              <Link href={`/accounts/${tx.account.id}`} className={link}>
                {tx.account.name}
              </Link>
            </td>

            {showCategory ? (
              <td className={`${td} opacity-60`}>
                {tx.categoryGroup && tx.categoryName ? (
                  <Link
                    href={`/categories/${slugify(tx.categoryGroup)}/${slugify(tx.categoryName)}`}
                    className={link}
                  >
                    {tx.categoryName}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
            ) : null}

            <td className={`${td} opacity-60`}>
                {tx.type}
            </td>

            <td
              className={`py-2 pl-4 text-right font-mono tabular-nums ${
                tx.amount > 0 ? "text-green-600 dark:text-green-400" : ""
              }`}
            >
              {formatMoney(tx.amount, tx.account.currency)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
