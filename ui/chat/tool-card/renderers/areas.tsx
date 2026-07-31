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

export function Areas({ result }: { result: Record<string, unknown> }) {
  const rows = asRows(result.areas);
  if (rows.length === 0) return <Empty>No spending areas.</Empty>;
  return (
    <Scroller>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Area</TableHead>
            <TableHead className="text-right">Transactions</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead>Main payees</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              <TableCell>{str(row.area)}</TableCell>
              <TableCell className="text-right tabular-nums">{str(row.transactions)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatMoney(num(row.total), str(result.currency) || null)}
              </TableCell>
              <TableCell className="max-w-xs truncate text-muted-foreground">
                {Array.isArray(row.topMerchants) ? row.topMerchants.slice(0, 4).join(", ") : ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Scroller>
  );
}
