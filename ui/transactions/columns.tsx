"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "@/ui/chrome/workspace-context";
import { LabelsCell } from "@/ui/transactions/labels-cell";
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
  showBalance = false,
}: {
  /** Off on a merchant's own page, where every row would link back to itself. */
  linkMerchant?: boolean;
  /** Off on a group's own page: the group subtitle under the category repeats it. */
  showGroup?: boolean;
  /** Show the running balance as a muted line under the amount (account ledgers). */
  showBalance?: boolean;
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
      // The one always-visible summary of what a row *is*: line 1 names the money
      // (merchant, transfer, or raw description); line 2 places it in the category
      // tree. The raw bank description and every other field move into the row's
      // expandable detail panel, so this column stays legible on a narrow screen.
      cell: ({ row }) => {
        const tx = row.original;
        const hasCategory = tx.categoryGroup && tx.category?.name;
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
              </div>
              {/* Line 2: the transaction date, then the category tree
                  ("Group › Category", folded in from its own former column). The
                  Date column is hidden by default but stays in the Columns menu,
                  where its header carries the sort link. On a group's own page the
                  group prefix is dropped (showGroup) since every row repeats it. */}
              <div className="text-xs opacity-60">
                <Link href={`/transactions/${tx.id}`} className={link}>
                  {formatDate(tx.date)}
                </Link>
                {hasCategory ? (
                  <>
                    {" · "}
                    {showGroup && tx.categoryGroup ? (
                      <>
                        <Link
                          href={`/categories/${slugify(tx.categoryGroup.name)}`}
                          className={link}
                        >
                          {tx.categoryGroup.name}
                        </Link>
                        {" › "}
                      </>
                    ) : null}
                    <Link
                      href={`/categories/${slugify(tx.categoryGroup!.name)}/${slugify(tx.category!.name)}`}
                      className={link}
                    >
                      {tx.category!.name}
                    </Link>
                  </>
                ) : null}
              </div>
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
      id: "labels",
      meta: { label: "Labels", cellClassName: "whitespace-normal" },
      header: "Labels",
      // The row's own tags, editable in place (add/remove) for an editor. Not
      // sortable — a set of tags has no single value to order by.
      cell: ({ row }) => {
        const tx = row.original;
        return <LabelsCell transactionId={tx.id} labels={tx.labels.map((l) => l.label)} />;
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
          <>
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
            {/* The running balance, folded in under the amount (account ledgers
                only). Smaller and muted so the transaction's own value stays the
                prominent number, and outside the amount's +/- colouring since it
                isn't the amount. */}
            {showBalance && tx.balance !== null ? (
              <div className="text-xs font-normal opacity-60">
                {formatMoney(tx.balance, tx.account.currency)}
              </div>
            ) : null}
          </>
        );
      },
    },
  ];
}
