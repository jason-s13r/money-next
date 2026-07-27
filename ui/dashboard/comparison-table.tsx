import { formatMoneyWhole } from "@/lib/format";

// Shared by the comparison table's server-rendered rows and by the client-side
// disclosure rows nested under them. The two must line up in the same columns at
// the same indent, so the measurements live in one place rather than twice.
//
// Nothing here may import `@/lib/metrics`: that module reaches the database, and
// these are used from inside a client component.
//
// This module is *neither* — no "use client", no server-only import — which is
// what lets both sides use it. That matters for `formatCell` below: the total
// rows render on the server and the disclosure rows on the client, and a helper
// living on either side could not be called from the other.

/** A value cell. Tabular figures so digits align down the column. */
export const CELL = "px-3 py-1.5 text-right font-mono tabular-nums";

/** A column heading. */
export const HEAD = "px-3 py-2 text-right font-medium text-secondary";

/**
 * The disclosure chevron's footprint, reserved on *every* category row whether or
 * not it can be expanded, so the swatches form one column down the table.
 */
export const CHEVRON = "size-3 shrink-0";

export function Swatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block size-2.5 shrink-0 rounded-[2px]"
      style={{ backgroundColor: color }}
    />
  );
}

/**
 * How a cell reads its figure.
 *
 * A named variant rather than a formatter function, and that is not a style
 * preference: the disclosure rows are a client component, and a function cannot
 * cross the RSC boundary — passing one in from a server page throws at runtime,
 * where nothing catches it at compile time. A string crosses fine.
 *
 * `variance` exists because the budget view reuses the same rows for a
 * *difference*, where the identical number means something else: −$120 is "under
 * budget", not "minus a hundred and twenty", and zero is "exactly on plan" rather
 * than "nothing happened". One row implementation, two ways of reading its cells.
 */
export type CellFormat = "money" | "variance";

export function formatCell(value: number, format: CellFormat = "money") {
  if (format === "variance") {
    // Rounded before the zero test, so a variance of a few cents reads as "on
    // plan" instead of as a signed figure too small to have a first digit.
    if (Math.round(value) === 0) return <span className="text-muted">on plan</span>;
    return `${value > 0 ? "+" : "−"}${formatMoneyWhole(Math.abs(value))}`;
  }
  return value === 0 ? <span className="text-muted">—</span> : formatMoneyWhole(value);
}
