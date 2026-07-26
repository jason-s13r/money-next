"use client";

import * as React from "react";
import type { VisibilityState } from "@tanstack/react-table";
import type { TransactionListItem } from "@/lib/server/queries/transactions";
import type { Sort } from "@/lib/transactions/sort";
import { useCanEdit } from "@/ui/chrome/workspace-context";
import { DataTable } from "@/ui/transactions/data-table";
import { buildTransactionColumns } from "@/ui/transactions/columns";
import { LabelCatalogProvider } from "@/ui/transactions/labels-cell";
import { TransactionBulkBar } from "@/ui/transactions/bulk-bar";
import { TransactionRowDetails } from "@/ui/transactions/row-details";

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
  "labels",
  "card",
  "type",
  "amount",
] as const;

export type TransactionColumnId = (typeof ALL_TRANSACTION_COLUMNS)[number];

// Only the essentials show as columns now; the rest of a row's fields live in the
// expandable detail panel (see {@link TransactionRowDetails}). The category tree,
// formerly its own column, is folded into the description's second line, and the
// running balance into a muted line under the amount. Everything still in
// ALL_TRANSACTION_COLUMNS remains one click away in the Columns menu.

/** What a general listing shows before the reader opens the Columns menu. */
export const DEFAULT_COLUMNS: readonly TransactionColumnId[] = [
  "description",
  "amount",
];

export function TransactionTable({
  items,
  defaultColumns = DEFAULT_COLUMNS,
  linkMerchant = true,
  showGroup = true,
  showBalance = false,
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
  /**
   * Show each row's running balance as a muted line under its amount. On only for
   * a single account's own ledger — a balance is meaningless once rows from
   * different accounts interleave.
   */
  showBalance?: boolean;
  /** The active column sort; with `sortBase`, turns the headers into sort links. */
  sort?: Sort;
  /** The listing's base path (no `?sort=`/`?page=`), for building header links. */
  sortBase?: string;
}) {
  const canEdit = useCanEdit();

  const columns = React.useMemo(
    () => buildTransactionColumns({ linkMerchant, showGroup, showBalance }),
    [linkMerchant, showGroup, showBalance],
  );

  // Every column the default set doesn't name starts hidden but stays in the
  // Columns menu, so the reader can reveal it.
  const initialColumnVisibility: VisibilityState = Object.fromEntries(
    ALL_TRANSACTION_COLUMNS.map((id) => [id, defaultColumns.includes(id)]),
  );

  // Selection and its bulk bar are an editor's tool: a viewer gets the same table
  // without the checkboxes. The label-catalog provider feeds every row's inline
  // tag picker from one fetch (and only when the reader can edit — see the provider).
  return (
    <LabelCatalogProvider>
      <DataTable
        columns={columns}
        data={items}
        initialColumnVisibility={initialColumnVisibility}
        sort={sort}
        sortBase={sortBase}
        enableSelection={canEdit}
        getRowId={(row) => row.id}
        renderBulkBar={
          canEdit
            ? (ids, clear) => <TransactionBulkBar ids={ids} clear={clear} />
            : undefined
        }
        renderSubRow={(tx) => <TransactionRowDetails tx={tx} />}
      />
    </LabelCatalogProvider>
  );
}
