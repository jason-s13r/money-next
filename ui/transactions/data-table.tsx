"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
  type RowSelectionState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ChevronDown, SlidersHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@/ui/chrome/workspace-context";
import { sortHref, type Sort } from "@/lib/transactions/sort";

// The interactive shell around a server page of rows. TanStack owns the column
// model and column visibility; the *ordering* and *paging* stay server-driven —
// headers link to `?sort=` (so they re-sort the whole dataset, not the visible
// page) and the page's own <Pagination> remains the pager.

export function DataTable<TData>({
  columns,
  data,
  initialColumnVisibility,
  sort,
  sortBase,
  enableSelection = false,
  getRowId,
  renderBulkBar,
  renderSubRow,
}: {
  columns: ColumnDef<TData>[];
  data: TData[];
  /** Columns hidden by default for this listing (the page's `show*` context). */
  initialColumnVisibility?: VisibilityState;
  /** The active sort, seeded from the url; drives the header arrows/links. */
  sort?: Sort;
  /** The listing's base path (no query); enables sortable headers when set. */
  sortBase?: string;
  /** Prepend a checkbox column and enable multi-row selection. */
  enableSelection?: boolean;
  /** Stable id for a row, so a selection is keyed by that id (e.g. a transaction id). */
  getRowId?: (row: TData) => string;
  /** The action bar to show while rows are selected; given the selected ids and a clear fn. */
  renderBulkBar?: (ids: string[], clear: () => void) => React.ReactNode;
  /**
   * The expanded detail panel for a row. When set, each row gains a trailing
   * chevron that opens this panel beneath it (the fields the reduced column set
   * leaves out), spanning the full table width.
   */
  renderSubRow?: (row: TData) => React.ReactNode;
}) {
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(
    initialColumnVisibility ?? {},
  );
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [expanded, setExpanded] = React.useState<ExpandedState>({});

  // The leading selection column, built here so the caller's column set stays
  // presentation-only and the same across selectable and plain listings.
  const selectionColumn: ColumnDef<TData> = React.useMemo(
    () => ({
      id: "select",
      enableHiding: false,
      meta: { headerClassName: "w-8", cellClassName: "w-8" },
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all rows"
          checked={table.getIsAllRowsSelected()}
          indeterminate={table.getIsSomeRowsSelected()}
          onCheckedChange={(checked) => table.toggleAllRowsSelected(checked)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label="Select row"
          checked={row.getIsSelected()}
          onCheckedChange={(checked) => row.toggleSelected(checked)}
        />
      ),
    }),
    [],
  );

  // The trailing expander column: a chevron that opens the row's detail panel.
  // `aria-expanded` on the button both drives the panel and (via the table row's
  // `has-aria-expanded` style) highlights the row while it is open.
  const expandable = !!renderSubRow;
  const expanderColumn: ColumnDef<TData> = React.useMemo(
    () => ({
      id: "expander",
      enableHiding: false,
      meta: { headerClassName: "w-8", cellClassName: "w-8 text-right" },
      header: () => null,
      cell: ({ row }) => (
        <button
          type="button"
          aria-label={row.getIsExpanded() ? "Hide details" : "Show details"}
          aria-expanded={row.getIsExpanded()}
          onClick={row.getToggleExpandedHandler()}
          className="rounded p-1 opacity-60 hover:bg-muted hover:opacity-100"
        >
          <ChevronDown
            className={cn(
              "size-4 transition-transform",
              row.getIsExpanded() && "rotate-180",
            )}
          />
        </button>
      ),
    }),
    [],
  );

  const allColumns = React.useMemo(
    () => [
      ...(enableSelection ? [selectionColumn] : []),
      ...columns,
      ...(expandable ? [expanderColumn] : []),
    ],
    [enableSelection, selectionColumn, columns, expandable, expanderColumn],
  );

  const table = useReactTable({
    data,
    columns: allColumns,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    // Every row can open its detail panel — there are no sub-rows to gate on, and
    // without this TanStack treats `getCanExpand()` as false and the toggle
    // handler becomes a no-op.
    getRowCanExpand: () => expandable,
    onColumnVisibilityChange: setColumnVisibility,
    enableRowSelection: enableSelection,
    onRowSelectionChange: setRowSelection,
    onExpandedChange: setExpanded,
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
    state: { columnVisibility, rowSelection, expanded },
  });

  const selectedIds = table.getSelectedRowModel().rows.map((row) => row.id);

  // The column picker rides in the first *content* header cell — not the selection
  // checkbox, which owns its own narrow cell.
  const pickerColumnId = table.getVisibleLeafColumns().find((c) => c.id !== "select")?.id;

  // The column picker rides in the first header cell as an icon button,
  // sitting alongside that column's own header content.
  const picker = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Toggle columns">
            <SlidersHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {table
            .getAllColumns()
            .filter((column) => column.getCanHide() && column.columnDef.meta?.label)
            .map((column) => (
              <DropdownMenuCheckboxItem
                key={column.id}
                className="capitalize"
                checked={column.getIsVisible()}
                closeOnClick={false}
                onCheckedChange={(value) => column.toggleVisibility(value === true)}
              >
                {column.columnDef.meta?.label}
              </DropdownMenuCheckboxItem>
            ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const meta = header.column.columnDef.meta;
                const field = meta?.sortField;
                const active = !!field && sort?.field === field;
                const content = header.isPlaceholder ? null : field &&
                  sort &&
                  sortBase ? (
                  <Link
                    href={sortHref(sortBase, field, sort)}
                    className="inline-flex items-center gap-1 hover:underline"
                  >
                    {meta?.label}
                    {active ? (
                      <span aria-hidden className="opacity-60">
                        {sort.dir === "asc" ? "↑" : "↓"}
                      </span>
                    ) : null}
                  </Link>
                ) : (
                  flexRender(header.column.columnDef.header, header.getContext())
                );
                return (
                  <TableHead
                    key={header.id}
                    className={meta?.headerClassName}
                    aria-sort={
                      active
                        ? sort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    {header.column.id === pickerColumnId ? (
                      <div className="flex items-center gap-2">
                        {picker}
                        {content}
                      </div>
                    ) : (
                      content
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <React.Fragment key={row.id}>
                <TableRow>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cell.column.columnDef.meta?.cellClassName}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
                {expandable && row.getIsExpanded() ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={row.getVisibleCells().length}
                      className="bg-muted/30 p-0 whitespace-normal"
                    >
                      {renderSubRow(row.original)}
                    </TableCell>
                  </TableRow>
                ) : null}
              </React.Fragment>
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={table.getVisibleFlatColumns().length}
                className="py-8 text-center opacity-60"
              >
                No transactions.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {renderBulkBar && selectedIds.length > 0
        ? renderBulkBar(selectedIds, () => table.resetRowSelection())
        : null}
    </div>
  );
}
