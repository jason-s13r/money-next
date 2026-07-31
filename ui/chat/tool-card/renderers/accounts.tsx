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

export function Accounts({ result }: { result: Record<string, unknown> }) {
  const rows = asRows(result.accounts);
  if (rows.length === 0) return <Empty>No active accounts.</Empty>;
  return (
    <Scroller>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              <TableCell>{str(row.account)}</TableCell>
              <TableCell className="text-muted-foreground">{str(row.type)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatMoney(num(row.balance), str(row.currency) || null)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Scroller>
  );
}
