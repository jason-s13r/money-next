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

/** The most rows rendered in one tool-result table. A model that reads more gets a
 *  note saying so — the full set went to the model, this is just the display cap. */
const MAX_RENDERED_ROWS = 200;

export function Transactions({
  result,
  withCategory = false,
}: {
  result: Record<string, unknown>;
  withCategory?: boolean;
}) {
  const rows = asRows(result.transactions);
  if (rows.length === 0) return <Empty>No transactions matched.</Empty>;
  return (
    <Scroller>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Payee</TableHead>
            <TableHead>Description</TableHead>
            {withCategory ? <TableHead>Category</TableHead> : null}
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.slice(0, MAX_RENDERED_ROWS).map((row, i) => (
            <TableRow key={i}>
              <TableCell className="whitespace-nowrap tabular-nums">{str(row.date)}</TableCell>
              <TableCell className="whitespace-nowrap">{str(row.merchant) || "—"}</TableCell>
              <TableCell className="max-w-xs truncate">{str(row.description)}</TableCell>
              {withCategory ? (
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {str(row.category) || "—"}
                </TableCell>
              ) : null}
              <TableCell className="text-right font-mono tabular-nums">
                {num(row.amount) === null ? "" : formatMoney(num(row.amount), null)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length > MAX_RENDERED_ROWS ? (
        <p className="pt-2 text-xs text-muted-foreground">
          Showing the first {MAX_RENDERED_ROWS} of {rows.length} rows the model was given.
        </p>
      ) : null}
    </Scroller>
  );
}
