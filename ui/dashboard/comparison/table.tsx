import type { Comparison } from "@/lib/server/metrics/comparison";
import { netOf } from "@/lib/server/metrics/comparison";
import { formatMoneyWhole } from "@/lib/format";
import { formatPeriodShort } from "@/lib/periods";
import { CELL, CHEVRON, HEAD } from "../comparison-table";
import { incomeNodes, spendNode } from "@/lib/server/metrics/comparison-nodes";
import { SpendRow } from "../spend-row";

/** Net colour: green for a surplus period, red for a deficit. */
const netClass = (net: number) => (net >= 0 ? "text-status-good" : "text-status-critical");
/** A net figure with an explicit + or − sign and no cents. */
const signedWhole = (net: number) => `${net >= 0 ? "+" : "−"}${formatMoneyWhole(Math.abs(net))}`;

/**
 * The bold summary row closing a block of category rows (total income, total
 * spending). Aligns with those rows by holding their chevron and swatch columns
 * empty rather than a colour.
 */
function TotalRow({ label, values }: { label: string; values: number[] }) {
  return (
    <tr className="border-t border-current/20 font-medium">
      <th scope="row" className="sticky left-0 bg-background px-3 py-1.5 text-left font-normal">
        <span className="flex items-center gap-2">
          <span className={CHEVRON} />
          <span className="size-2.5 shrink-0" />
          {label}
        </span>
      </th>
      {values.map((value, i) => (
        <td key={i} className={CELL}>
          {value === 0 ? <span className="text-muted">—</span> : formatMoneyWhole(value)}
        </td>
      ))}
    </tr>
  );
}

/** The values behind every bar, for anyone the colours fail. */
export function ComparisonTable({ comparison }: { comparison: Comparison }) {
  const { periods, spendCategories, period } = comparison;
  const partialKey = periods.find((p) => p.partial)?.key;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-3xl text-sm">
        <thead>
          <tr className="border-b border-current/20">
            <th scope="col" className="sticky left-0 bg-background px-3 py-2 text-left font-medium">
              Category
            </th>
            {periods.map((p) => (
              <th key={p.key} scope="col" className={HEAD}>
                {formatPeriodShort(p.key, period)}
                {p.key === partialKey ? <span className="text-muted"> *</span> : null}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          <tr>
            <th colSpan={periods.length + 1} scope="colgroup" className="px-3 pt-4 pb-1 text-left text-xs text-muted">
              Income
            </th>
          </tr>
          {incomeNodes(comparison).map((node) => (
            <SpendRow key={node.label} row={node} />
          ))}
          <TotalRow label="Total income" values={periods.map((p) => p.incomeTotal)} />

          <tr>
            <th colSpan={periods.length + 1} scope="colgroup" className="px-3 pt-4 pb-1 text-left text-xs text-muted">
              Spending
            </th>
          </tr>
          {spendCategories.map((category) => (
            <SpendRow key={category} row={spendNode(comparison, category)} />
          ))}
          <TotalRow label="Total spending" values={periods.map((p) => p.spendTotal)} />

          <tr className="border-t border-current/20 font-medium">
            <th scope="row" className="sticky left-0 bg-background px-3 py-2 text-left">
              <span className="flex items-center gap-2">
                <span className={CHEVRON} />
                <span className="size-2.5 shrink-0" />
                Net
              </span>
            </th>
            {periods.map((p) => {
              const net = netOf(p);
              return (
                <td key={p.key} className={`${CELL} ${netClass(net)}`}>
                  {signedWhole(net)}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
