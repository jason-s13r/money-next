import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { Empty, Scroller } from "../primitives";
import { asRows, isRecord, str } from "../utils";
import { Transactions } from "./transactions";

export function Rules({ result }: { result: Record<string, unknown> }) {
  const rows = asRows(result.rules);
  if (rows.length === 0) return <Empty>No rules yet.</Empty>;
  return (
    <Scroller>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Sets category</TableHead>
            <TableHead>Sets payee</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              <TableCell className="max-w-sm">
                {isRecord(row.matches) ? str(row.matches.meaning) || str(row.matches.handWritten) : ""}
              </TableCell>
              <TableCell className="text-muted-foreground">{str(row.setsCategory) || "—"}</TableCell>
              <TableCell className="text-muted-foreground">{str(row.setsMerchant) || "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Scroller>
  );
}

export function RulePreview({ result }: { result: Record<string, unknown> }) {
  const rule = isRecord(result.rule) ? result.rule : result;
  const now = isRecord(result.categorisedNow) ? result.categorisedNow : null;
  const matches = result.matches ?? result.matchesNow;

  return (
    <div className="space-y-2 text-xs">
      <p>
        <span className="text-muted-foreground">When </span>
        {str(rule.meaning)}
      </p>
      {str(rule.setsCategory) || str(rule.setsMerchant) ? (
        <p>
          <span className="text-muted-foreground">Sets </span>
          {[str(rule.setsCategory), str(rule.setsMerchant)].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {matches === undefined ? null : (
        <p>
          <span className="text-muted-foreground">Matches </span>
          {String(matches)} transaction(s) already here.
        </p>
      )}
      {now && Object.keys(now).length > 0 ? (
        <div>
          <p className="mb-1 text-muted-foreground">Currently filed as</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {Object.entries(now).map(([category, count]) => (
              <li key={category}>
                {category} — {String(count)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {asRows(result.examples).length > 0 ? (
        <Transactions result={{ transactions: result.examples }} withCategory />
      ) : null}
    </div>
  );
}
