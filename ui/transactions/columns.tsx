"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "@/ui/chrome/workspace-context";
import type { TransactionListItem } from "@/lib/server/queries/transactions";
import {
  DEFAULT_CURRENCY as DISPLAY_CURRENCY,
  formatDate,
  formatMoney,
} from "@/lib/format";
import { slugify } from "@/lib/slug";
import { positiveAmountClass } from "@/lib/ui/amount";
import type { SortField } from "@/lib/transactions/sort";

// The TanStack column model behind {@link TransactionTable}. Each cell renderer is
// the same JSX the hand-rolled table used to inline — logos, foreign-currency
// sub-lines, the "needs review" dot, the transfer summary — just relocated so the
// table gains sortable headers, a column menu, and row selection for free. Two
// flags change what a cell *renders* (not merely whether a column shows), so they
// are baked in here; the plain show/hide flags map to initial column visibility in
// the wrapper instead.

const link = "underline underline-offset-2";

// Column metadata the DataTable reads: a human label for the columns menu, the
// url sort key (when the column is sortable), and per-column alignment classes.
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    label?: string;
    sortField?: SortField;
    headerClassName?: string;
    cellClassName?: string;
  }
}

export function buildTransactionColumns({
  linkMerchant = true,
  showGroup = true,
}: {
  /** Off on a merchant's own page, where every row would link back to itself. */
  linkMerchant?: boolean;
  /** Off on a group's own page: the group subtitle under the category repeats it. */
  showGroup?: boolean;
}): ColumnDef<TransactionListItem>[] {
  return [
    {
      id: "date",
      meta: { label: "Date", sortField: "date", cellClassName: "opacity-60" },
      header: "Date",
      cell: ({ row }) => {
        const tx = row.original;
        return (
          <Link href={`/transactions/${tx.id}`} className={link}>
            {formatDate(tx.date)}
          </Link>
        );
      },
    },

    {
      id: "description",
      meta: {
        label: "Description",
        sortField: "description",
        cellClassName: "whitespace-normal break-words",
      },
      header: "Description",
      cell: ({ row }) => {
        const tx = row.original;
        return (
          <div className="flex items-center gap-2">
            {tx.merchant?.logo ? (
              <img
                src={tx.merchant.logo}
                alt=""
                className="h-5 w-5 rounded object-contain"
              />
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
                  transfer summary never hides what the statement actually said. */}
              {tx.transfer || tx.merchant?.name ? (
                <div className="text-xs opacity-60">{tx.description}</div>
              ) : null}
            </div>
          </div>
        );
      },
    },

    {
      id: "account",
      meta: {
        label: "Account",
        sortField: "account",
        cellClassName: "whitespace-normal opacity-60",
      },
      header: "Account",
      cell: ({ row }) => {
        const tx = row.original;
        return (
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
        );
      },
    },

    {
      id: "category",
      meta: {
        label: "Category",
        sortField: "category",
        cellClassName: "whitespace-normal opacity-60",
      },
      header: "Category",
      cell: ({ row }) => {
        const tx = row.original;
        return (
          <>
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
            {/* The group carrying the category, unless the page is itself a group
                (then every row would repeat it). */}
            {showGroup && tx.categoryGroup ? (
              <div className="text-xs opacity-60">
                <Link
                  href={`/categories/${slugify(tx.categoryGroup.name)}`}
                  className={link}
                >
                  {tx.categoryGroup.name}
                </Link>
              </div>
            ) : null}
          </>
        );
      },
    },

    {
      id: "card",
      meta: { label: "Card", sortField: "card", cellClassName: "opacity-60" },
      header: "Card",
      cell: ({ row }) => {
        const tx = row.original;
        return tx.cardSuffix ? (
          <Link href={`/card/${tx.cardSuffix}`} className={link}>
            ····{tx.cardSuffix}
          </Link>
        ) : (
          "—"
        );
      },
    },

    {
      id: "type",
      meta: {
        label: "Type",
        sortField: "type",
        cellClassName: "whitespace-normal opacity-60",
      },
      header: "Type",
      cell: ({ row }) => {
        const tx = row.original;
        return (
          <Link href={`/transactions/type/${slugify(tx.type)}`} className={link}>
            {tx.type}
          </Link>
        );
      },
    },

    {
      id: "amount",
      meta: {
        label: "Amount",
        sortField: "amount",
        headerClassName: "text-right",
        cellClassName: "text-right font-mono tabular-nums",
      },
      header: "Amount",
      cell: ({ row }) => {
        const tx = row.original;
        return (
          <div className={positiveAmountClass(tx.amount)}>
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
          </div>
        );
      },
    },

    {
      id: "balance",
      meta: {
        label: "Balance",
        sortField: "balance",
        headerClassName: "text-right",
        cellClassName: "text-right font-mono tabular-nums opacity-60",
      },
      header: "Balance",
      cell: ({ row }) => {
        const tx = row.original;
        return formatMoney(tx.balance, tx.account.currency);
      },
    },
  ];
}
