import { Link } from "@/ui/chrome/workspace-context";
import type { PendingTransactionItem } from "@/lib/server/queries/pending";
import { DEFAULT_CURRENCY as DISPLAY_CURRENCY, formatDate, formatMoney } from "@/lib/format";
import { positiveAmountClass } from "@/lib/ui/amount";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Pending (authorised but unsettled) holds, shown atop the first page of a
// listing. Deliberately leaner than TransactionTable: pending rows have no stable
// id (so no detail link), no running balance, and no merchant/category — Akahu
// attaches only `meta` to them (see the PendingTransaction model). The whole block
// is muted and badged so it never reads as settled, spent money. It stays static
// (no sort/filter/selection), so it renders the shared <Table> primitives directly
// rather than going through the interactive DataTable.

export function PendingTable({
  items,
  showAccount = true,
}: {
  items: PendingTransactionItem[];
  /** Off on an account's own page, where every row is that same account. */
  showAccount?: boolean;
}) {
  const link = "underline underline-offset-2";

  return (
    <section className="mb-6 opacity-80">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium opacity-80">
        Pending
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-normal text-amber-700 dark:text-amber-400">
          {items.length} not yet settled
        </span>
      </h2>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead>Card</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((tx) => (
            <TableRow key={tx.id}>
              {/* Description over a muted second line carrying the date and, off an
                  account page, which account the hold sits on. */}
              <TableCell>
                <div>{tx.description}</div>
                <div className="text-xs opacity-60">
                  {formatDate(tx.date)}
                  {showAccount ? (
                    <>
                      {" · "}
                      <span className="inline-flex items-center gap-1 align-middle">
                        {tx.account.connection?.logo ? (
                          <img
                            src={tx.account.connection.logo}
                            alt=""
                            className="h-4 w-4 rounded object-contain"
                          />
                        ) : null}
                        <Link href={`/accounts/${tx.account.id}`} className={link}>
                          {tx.account.name}
                        </Link>
                      </span>
                    </>
                  ) : null}
                </div>
              </TableCell>

              {/* Card over its type — the row's raw bank descriptors, both muted. */}
              <TableCell className="opacity-60">
                <div>
                  {tx.cardSuffix ? (
                    <Link href={`/card/${tx.cardSuffix}`} className={link}>
                      ····{tx.cardSuffix}
                    </Link>
                  ) : (
                    "—"
                  )}
                </div>
                <div className="text-xs">{tx.type}</div>
              </TableCell>

              <TableCell className={`text-right font-mono tabular-nums ${positiveAmountClass(tx.amount)}`}>
                {formatMoney(tx.amount, tx.account.currency)}
                {tx.account.currency &&
                tx.account.currency !== DISPLAY_CURRENCY &&
                tx.amountBase !== null ? (
                  <div className="text-xs font-normal opacity-60">
                    ≈ {formatMoney(tx.amountBase, DISPLAY_CURRENCY)}
                  </div>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
