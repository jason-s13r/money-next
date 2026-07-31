import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/format";

import { Empty, Scroller } from "../primitives";
import { asRows, num, str } from "../utils";

export function BudgetItems({ result }: { result: Record<string, unknown> }) {
  const rows = asRows(result.items);
  if (rows.length === 0) return <Empty>This budget has no items.</Empty>;
  return (
    <Scroller>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead>Area</TableHead>
            <TableHead>Cadence</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              <TableCell>{str(row.name)}</TableCell>
              <TableCell className="text-muted-foreground">{str(row.area)}</TableCell>
              <TableCell className="text-muted-foreground">{str(row.cadence)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatMoney(
                  row.direction === "income" ? num(row.amount) : -(num(row.amount) ?? 0),
                  str(result.currency) || null,
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Scroller>
  );
}

export function WrittenItems({ result }: { result: Record<string, unknown> }) {
  const rows = asRows(result.items);
  const rejected = Array.isArray(result.rejected) ? result.rejected : [];
  return (
    <div className="space-y-2">
      {rows.length > 0 ? (
        <Scroller>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Area</TableHead>
                <TableHead>Cadence</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>
                  <TableCell>{str(row.name)}</TableCell>
                  <TableCell className="text-muted-foreground">{str(row.area)}</TableCell>
                  <TableCell className="text-muted-foreground">{str(row.cadence)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatMoney(num(row.amount), null)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Scroller>
      ) : null}
      {rejected.length > 0 ? (
        <div className="text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-status-warning">Rejected</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {rejected.map((line, i) => (
              <li key={i}>{String(line)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
