"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from "@tanstack/react-table";
import { SlidersHorizontal } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
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
}: {
  columns: ColumnDef<TData>[];
  data: TData[];
  /** Columns hidden by default for this listing (the page's `show*` context). */
  initialColumnVisibility?: VisibilityState;
  /** The active sort, seeded from the url; drives the header arrows/links. */
  sort?: Sort;
  /** The listing's base path (no query); enables sortable headers when set. */
  sortBase?: string;
}) {
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(
    initialColumnVisibility ?? {},
  );

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    state: { columnVisibility },
  });

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
              {headerGroup.headers.map((header, index) => {
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
                    {index === 0 ? (
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
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cell.column.columnDef.meta?.cellClassName}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
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
    </div>
  );
}
