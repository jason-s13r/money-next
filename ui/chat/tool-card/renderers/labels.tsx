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

export function Labels({ result }: { result: Record<string, unknown> }) {
  const rows = asRows(result.labels);
  if (rows.length === 0) return <Empty>No tags yet.</Empty>;
  return (
    <Scroller>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tag</TableHead>
            <TableHead className="text-right">Transactions</TableHead>
            <TableHead className="text-right">Net</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              <TableCell>
                {str(row.label)}
                {row.managedByTheApp ? (
                  <span className="ml-2 text-muted-foreground">automatic</span>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">{str(row.transactions)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatMoney(num(row.net), str(result.currency) || null)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Scroller>
  );
}
