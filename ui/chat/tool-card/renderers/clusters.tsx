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
import { asRows, isRecord, num, str } from "../utils";

export function Clusters({ groups }: { groups: Record<string, unknown> }) {
  const rows = asRows(groups.similar);
  const ungrouped = isRecord(groups.noSharedWords) ? groups.noSharedWords : null;
  if (rows.length === 0 && !ungrouped) return <Empty>Nothing left uncategorised.</Empty>;

  return (
    <div className="space-y-2">
      {rows.length > 0 ? (
        <Scroller>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Looks like</TableHead>
                <TableHead>Shared words</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>
                  <TableCell className="max-w-xs truncate">{str(row.example)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {Array.isArray(row.words) ? row.words.join(", ") : ""}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{str(row.count)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatMoney(num(row.total), null)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Scroller>
      ) : null}
      {ungrouped ? (
        <p className="text-xs text-muted-foreground">
          {str(ungrouped.count)} with nothing stable to match on — these have to be done
          individually.
        </p>
      ) : null}
    </div>
  );
}
