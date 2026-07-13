import Link from "next/link";
import type { TransactionListItem } from "@/lib/data";
import { formatDate, formatMoney } from "@/lib/format";
import { slugify } from "@/lib/slug";

// The one table every "what is in this bucket?" page renders, so their columns
// stay identical. A page turns off whichever column merely repeats its own
// heading — a category page whose Category column reads the same 50 times is 50
// rows of noise — and turns on the two only a single-account page can fill (its
// own Account name, and a running Balance that is meaningless once rows from
// different accounts interleave).

// The currency every row's amount is compared in; a foreign-currency row shows
// its converted value beneath the raw one. Matches `DISPLAY_CURRENCY` in data.ts.
const DISPLAY_CURRENCY = "NZD";

export function TransactionTable({
  items,
  showAccount = true,
  showGroup = true,
  showCategory = true,
  showCard = true,
  showType = true,
  showBalance = false,
  linkMerchant = true,
}: {
  items: TransactionListItem[];
  /** Off on an account's own page, where every row is that same account. */
  showAccount?: boolean;
  /** Off on a group's own page: the group subtitle under the category repeats it. */
  showGroup?: boolean;
  showCategory?: boolean;
  /** Off on a card's own page, where every row is that same card. */
  showCard?: boolean;
  /** Off on a type's own page, where every row would read the same type. */
  showType?: boolean;
  /** On only for a single-account page; a running balance needs one account. */
  showBalance?: boolean;
  /** Off on a merchant's own page, where every row would link back to itself. */
  linkMerchant?: boolean;
}) {
  const th = "py-2 pr-4 font-medium";
  const thRight = "py-2 pl-4 text-right font-medium";
  const td = "py-2 pr-4";
  const tdNum = "py-2 pl-4 text-right font-mono tabular-nums";
  const link = "underline underline-offset-2";

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-current/20 text-left">
          <th className={th}>Date</th>
          <th className={th}>Description</th>
          {showAccount ? <th className={th}>Account</th> : null}
          {showCategory ? <th className={th}>Category</th> : null}
          {showCard ? <th className={th}>Card</th> : null}
          {showType ? <th className={th}>Type</th> : null}
          <th className={thRight}>Amount</th>
          {showBalance ? <th className={thRight}>Balance</th> : null}
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
              {/* An open enrichment conflict is flagged where the row is read, not
                  only on its own page. */}
              {tx.needsReview ? (
                <span
                  title="Needs review"
                  className="mr-1.5 text-amber-600 dark:text-amber-400"
                >
                  ●
                </span>
              ) : null}
              {tx.transfer ? (
                // A linked transfer reads as its summary, linked to the tx page
                // where the whole group and its legs live.
                <Link href={`/transactions/${tx.id}`} className={link}>
                  {tx.transfer.label}
                </Link>
              ) : tx.merchantName && tx.merchantId && linkMerchant ? (
                <Link href={`/merchants/${tx.merchantId}`} className={link}>
                  {tx.merchantName}
                </Link>
              ) : (
                (tx.merchantName ?? tx.description)
              )}
              {/* The raw bank description, always, so an enriched merchant name or
                  transfer summary never hides what the statement actually said.
                  Skipped when the line above already is the description. */}
              {tx.transfer || tx.merchantName ? (
                <div className="text-xs opacity-60">{tx.description}</div>
              ) : null}
            </td>

            {showAccount ? (
              <td className={`${td} opacity-60`}>
                <Link href={`/accounts/${tx.account.id}`} className={link}>
                  {tx.account.name}
                </Link>
              </td>
            ) : null}

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
                {/* The group carrying the category, unless the page is itself a
                    group (then every row would repeat it). */}
                {showGroup && tx.categoryGroup ? (
                  <div className="text-xs opacity-60">
                    <Link href={`/categories/${slugify(tx.categoryGroup)}`} className={link}>
                      {tx.categoryGroup}
                    </Link>
                  </div>
                ) : null}
              </td>
            ) : null}

            {showCard ? (
              <td className={`${td} opacity-60`}>
                {tx.cardSuffix ? (
                  <Link href={`/card/${tx.cardSuffix}`} className={link}>
                    ····{tx.cardSuffix}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
            ) : null}

            {showType ? (
              <td className={`${td} opacity-60`}>
                <Link href={`/transactions/type/${slugify(tx.type)}`} className={link}>
                  {tx.type}
                </Link>
              </td>
            ) : null}

            <td
              className={`${tdNum} ${tx.amount > 0 ? "text-green-600 dark:text-green-400" : ""}`}
            >
              {formatMoney(tx.amount, tx.account.currency)}
              {/* A foreign-currency row also carries its value in the display
                  currency, so the column is comparable top to bottom. */}
              {tx.account.currency &&
              tx.account.currency !== DISPLAY_CURRENCY &&
              tx.amountBase !== null ? (
                <div className="text-xs font-normal opacity-60">
                  ≈ {formatMoney(tx.amountBase, DISPLAY_CURRENCY)}
                </div>
              ) : null}
            </td>

            {showBalance ? (
              <td className={`${tdNum} opacity-60`}>
                {formatMoney(tx.balance, tx.account.currency)}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
