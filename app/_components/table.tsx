// Shared by the comparison table's server-rendered rows and by the client-side
// disclosure rows nested under them. The two must line up in the same columns at
// the same indent, so the measurements live in one place rather than twice.
//
// Nothing here may import `@/lib/metrics`: that module reaches the database, and
// these are used from inside a client component.

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
