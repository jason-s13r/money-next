import { Link } from "@/ui/chrome/workspace-context";
import type { TransactionListItem } from "@/lib/server/queries/transactions";
import { DEFAULT_CURRENCY as DISPLAY_CURRENCY, formatDate, formatMoney } from "@/lib/format";
import { slugify } from "@/lib/slug";
import { positiveAmountClass } from "@/lib/ui/amount";
import { sortHref, type Sort, type SortField } from "@/lib/transactions/sort";

// The one table every "what is in this bucket?" page renders, so their columns
// stay identical. A page turns off whichever column merely repeats its own
// heading — a category page whose Category column reads the same 50 times is 50
// rows of noise — and turns on the two only a single-account page can fill (its
// own Account name, and a running Balance that is meaningless once rows from
// different accounts interleave).

// The currency every row's amount is compared in (`amountBase`, computed in
// data.ts); a foreign-currency row shows its converted value beneath the raw one.

export function TransactionTable({
  items,
  showAccount = true,
  showGroup = true,
  showCategory = true,
  showCard = true,
  showType = true,
  showBalance = false,
  linkMerchant = true,
  sort,
  sortBase,
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
  /** The active column sort; with `sortBase`, turns the headers into sort links. */
  sort?: Sort;
  /** The listing's base path (no `?sort=`/`?page=`), for building header links. */
  sortBase?: string;
}) {
  const th = "py-2 pr-4 font-medium";
  const thRight = "py-2 pl-4 text-right font-medium";
  const td = "py-2 pr-4";
  const tdNum = "py-2 pl-4 text-right font-mono tabular-nums";
  const link = "underline underline-offset-2";

  // Passed to every header so a column can turn itself into a sort link; see
  // {@link ColumnHeader}.
  const sorting = { sort, sortBase };

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-current/20 text-left">
          <ColumnHeader field="date" label="Date" className={th} {...sorting} />
          <ColumnHeader field="description" label="Description" className={th} {...sorting} />
          {showAccount ? <ColumnHeader field="account" label="Account" className={th} {...sorting} /> : null}
          {showCategory ? <ColumnHeader field="category" label="Category" className={th} {...sorting} /> : null}
          {showCard ? <ColumnHeader field="card" label="Card" className={th} {...sorting} /> : null}
          {showType ? <ColumnHeader field="type" label="Type" className={th} {...sorting} /> : null}
          <ColumnHeader field="amount" label="Amount" className={thRight} {...sorting} />
          {showBalance ? <ColumnHeader field="balance" label="Balance" className={thRight} {...sorting} /> : null}
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
              <div className="flex items-center gap-2">
                {tx.merchant?.logo ? (
                  <img src={tx.merchant.logo} alt="" className="h-5 w-5 rounded object-contain" />
                ) : null}
                <div>
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
                  ) : tx.merchant?.name && tx.merchantId && linkMerchant ? (
                    <Link href={`/merchants/${tx.merchantId}`} className={link}>
                      {tx.merchant.name}
                    </Link>
                  ) : (
                    (tx.merchant?.name ?? tx.description)
                  )}
                  {/* The raw bank description, always, so an enriched merchant name or
                      transfer summary never hides what the statement actually said.
                      Skipped when the line above already is the description. */}
                  {tx.transfer || tx.merchant?.name ? (
                    <div className="text-xs opacity-60">{tx.description}</div>
                  ) : null}
                </div>
              </div>
            </td>

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

            {showCategory ? (
              <td className={`${td} opacity-60`}>
                {tx.categoryGroup && tx.category?.name ? (
                  <Link
                    href={`/categories/${slugify(tx.categoryGroup.name)}/${slugify(tx.category.name)}`}
                    className={link}
                  >
                    {tx.category.name}
                  </Link>
                ) : (
                  "—"
                )}
                {/* The group carrying the category, unless the page is itself a
                    group (then every row would repeat it). */}
                {showGroup && tx.categoryGroup ? (
                  <div className="text-xs opacity-60">
                    <Link href={`/categories/${slugify(tx.categoryGroup.name)}`} className={link}>
                      {tx.categoryGroup.name}
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

            <td className={`${tdNum} ${positiveAmountClass(tx.amount)}`}>
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

/**
 * One column header. A plain cell until the listing opts into sorting by passing
 * both `sort` and `sortBase` (see {@link TransactionTable}), at which point it
 * becomes a link that re-sorts by this column — the active column marked with
 * `aria-sort` and an arrow. Listings that don't wire sorting render as before.
 */
function ColumnHeader({
  field,
  label,
  className,
  sort,
  sortBase,
}: {
  field: SortField;
  label: string;
  className: string;
  sort?: Sort;
  sortBase?: string;
}) {
  if (!sort || !sortBase) return <th className={className}>{label}</th>;

  const active = sort.field === field;
  return (
    <th
      className={className}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <Link
        href={sortHref(sortBase, field, sort)}
        className="inline-flex items-center gap-1 hover:underline"
      >
        {label}
        {active ? (
          <span aria-hidden className="opacity-60">
            {sort.dir === "asc" ? "↑" : "↓"}
          </span>
        ) : null}
      </Link>
    </th>
  );
}
