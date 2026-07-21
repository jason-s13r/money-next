"use client";

import * as React from "react";
import type { VisibilityState } from "@tanstack/react-table";
import type { TransactionListItem } from "@/lib/server/queries/transactions";
import type { Sort } from "@/lib/transactions/sort";
import { DataTable } from "@/ui/transactions/data-table";
import { buildTransactionColumns } from "@/ui/transactions/columns";

// The one table every "what is in this bucket?" page renders. Which columns a
// reader sees is now theirs to decide: every listing starts from the same default
// set and the rest wait one click away in the Columns menu, so a page no longer
// hand-tunes its columns with `show*` props. Only `linkMerchant`/`showGroup`
// remain, because those change what a cell *renders* (a self-link, a repeated
// group subtitle), not merely whether a column is shown.
//
// Built on TanStack Table (see {@link DataTable} and {@link buildTransactionColumns}).
// Ordering and paging stay server-driven: headers link to `?sort=` and the page's
// own <Pagination> stays the pager.

export const ALL_TRANSACTION_COLUMNS = [
  "date",
  "description",
  "account",
  "category",
  "card",
  "type",
  "amount",
  "balance",
] as const;

export type TransactionColumnId = (typeof ALL_TRANSACTION_COLUMNS)[number];

/** What a general listing shows before the reader opens the Columns menu. */
export const DEFAULT_COLUMNS: readonly TransactionColumnId[] = [
  "date",
  "description",
  "category",
  "card",
  "amount",
];

/** An account's own ledger, which adds its running Balance to the default set. */
export const ACCOUNT_COLUMNS: readonly TransactionColumnId[] = [
  ...DEFAULT_COLUMNS,
  "balance",
];

export function TransactionTable({
  items,
  defaultColumns = DEFAULT_COLUMNS,
  linkMerchant = true,
  showGroup = true,
  sort,
  sortBase,
}: {
  items: TransactionListItem[];
  /** The columns visible before the reader opens the Columns menu; the rest wait there. */
  defaultColumns?: readonly TransactionColumnId[];
  /** Off on a merchant's own page, where every row would link back to itself. */
  linkMerchant?: boolean;
  /** Off on a group's own page: the group subtitle under the category repeats it. */
  showGroup?: boolean;
  /** The active column sort; with `sortBase`, turns the headers into sort links. */
  sort?: Sort;
  /** The listing's base path (no `?sort=`/`?page=`), for building header links. */
  sortBase?: string;
}) {
  const columns = React.useMemo(
    () => buildTransactionColumns({ linkMerchant, showGroup }),
    [linkMerchant, showGroup],
  );

  // Every column the default set doesn't name starts hidden but stays in the
  // Columns menu, so the reader can reveal it.
  const initialColumnVisibility: VisibilityState = Object.fromEntries(
    ALL_TRANSACTION_COLUMNS.map((id) => [id, defaultColumns.includes(id)]),
  );

  return (
    <DataTable
      columns={columns}
      data={items}
      initialColumnVisibility={initialColumnVisibility}
      sort={sort}
      sortBase={sortBase}
    />
  );
}
