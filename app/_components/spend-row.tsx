"use client";

import Link from "next/link";
import { useState } from "react";
import { formatMoneyWhole } from "@/lib/format";
import { CELL, CHEVRON, Swatch } from "./table";

/** A row and everything it is made of. Three levels: group → category → merchant. */
export type SpendNode = {
  label: string;
  /** Null where the row is an aggregate this chart invented, or an unnamed merchant. */
  href: string | null;
  values: number[];
  /** Only the top level carries a colour; the levels below inherit its meaning. */
  color?: string;
  /** Empty when the breakdown would only restate the row: nothing to open. */
  children: SpendNode[];
};

/** Each level indents by one chevron, so a row's depth is legible from its stem. */
const INDENT_REM = 1.25;

/**
 * A spending row that opens to show what it is made of, recursively.
 *
 * Not <details>/<summary>: neither may wrap a group of <tr>s, and the breakdown
 * has to keep the same columns as the total above it — a merchant's March is only
 * meaningful under the category's March. A button carrying `aria-expanded` is the
 * accessible equivalent.
 *
 * The chevron expands and the name navigates. They are separate targets because
 * they are separate questions: "what is inside this row" and "which transactions
 * are these". A single control could only answer one of them.
 *
 * Closed by default, at every level. The table's job is the ten categories.
 */
export function SpendRow({ row, depth = 0 }: { row: SpendNode; depth?: number }) {
  const [open, setOpen] = useState(false);
  const expandable = row.children.length > 0;
  const link = "underline decoration-current/25 underline-offset-2 hover:decoration-current";

  const tone = depth === 0 ? "" : depth === 1 ? "text-secondary" : "text-muted";

  return (
    <>
      <tr className={tone}>
        <th
          scope="row"
          className="sticky left-0 bg-background py-1.5 pr-3 text-left font-normal"
          style={{ paddingLeft: `${0.75 + depth * INDENT_REM}rem` }}
        >
          <span className="flex items-center gap-2">
            {expandable ? (
              <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                aria-label={`${open ? "Hide" : "Show"} what ${row.label} is made of`}
                className="rounded-sm text-muted hover:text-foreground"
              >
                <svg
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  className={`${CHEVRON} transition-transform ${open ? "rotate-90" : ""}`}
                >
                  <path
                    d="M4.5 2.5 L8 6 L4.5 9.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : (
              <span className={CHEVRON} />
            )}

            {row.color ? <Swatch color={row.color} /> : null}

            {row.href ? (
              <Link href={row.href} className={link}>
                {row.label}
              </Link>
            ) : (
              row.label
            )}
          </span>
        </th>

        {row.values.map((value, i) => (
          <td key={i} className={CELL}>
            {value === 0 ? <span className="text-muted">—</span> : formatMoneyWhole(value)}
          </td>
        ))}
      </tr>

      {open
        ? row.children.map((child) => (
            <SpendRow key={child.label} row={child} depth={depth + 1} />
          ))
        : null}
    </>
  );
}
