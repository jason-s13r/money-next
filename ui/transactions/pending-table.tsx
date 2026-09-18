"use client";

import Image from "next/image";
import { useState, useTransition } from "react";

import { dismissPending, restorePending } from "@/app/w/[workspace]/transactions/actions/pending";
import { Link, useCanEdit, useRelativePath } from "@/ui/chrome/workspace-context";
import type {
  DismissalView,
  DismissedPendingItem,
  PendingList,
  PendingTransactionItem,
} from "@/lib/server/queries/pending";
import { DEFAULT_CURRENCY as DISPLAY_CURRENCY, formatDate, formatMoney } from "@/lib/format";
import { accountLabel } from "@/lib/account-name";
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
//
// Client-side now that a hold can be dismissed: revealing what is hidden is local
// state, and the two writes are transitions. Everything shown is still the
// server's — the actions revalidate the page rather than editing a local copy.

const CHIP = "rounded bg-current/10 px-1.5 py-0.5 font-mono text-xs";

export function PendingTable({
  pending,
  showAccount = true,
}: {
  pending: PendingList;
  /** Off on an account's own page, where every row is that same account. */
  showAccount?: boolean;
}) {
  const { items, dismissed, rules } = pending;
  const [revealed, setRevealed] = useState(false);
  const canEdit = useCanEdit();

  // Nothing pending and nothing hidden: no block. A listing whose only holds are
  // dismissed still renders, because the dismissals are reachable nowhere else —
  // the rule and the rows it hides are shown together or not at all.
  if (items.length === 0 && dismissed.length === 0) return null;

  // The dismiss column only exists for someone who can write. A viewer gets the
  // same three columns the block has always had, so `colSpan` has to ask.
  const columns = canEdit ? 4 : 3;

  return (
    <section className="mb-6 opacity-80">
      <h2 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-medium opacity-80">
        Pending
        {items.length > 0 ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-normal text-amber-700 dark:text-amber-400">
            {items.length} not yet settled
          </span>
        ) : null}
        {/* Readable by a viewer too: that holds are being hidden is information
            about why the list looks the way it does, not an edit. */}
        {dismissed.length > 0 ? (
          <button
            type="button"
            onClick={() => setRevealed((shown) => !shown)}
            aria-expanded={revealed}
            className="text-xs font-normal opacity-60 underline-offset-2 transition-opacity hover:opacity-100 hover:underline"
          >
            {revealed ? "Hide dismissed" : `${dismissed.length} dismissed`}
          </button>
        ) : null}
      </h2>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead>Card</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            {canEdit ? (
              <TableHead className="w-0">
                <span className="sr-only">Actions</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((tx) => (
            <PendingRow key={tx.id} tx={tx} showAccount={showAccount} canEdit={canEdit} />
          ))}

          {/* Each dismissal, then the holds it is holding back — grouped that way
              because undoing is per rule, not per row: a rule the person taught
              from one Wise cashback is hiding the other three as well, and a
              button on each row would promise otherwise. */}
          {revealed
            ? rules.map((rule) => (
                <DismissedGroup
                  key={rule.id}
                  rule={rule}
                  rows={dismissed.filter((tx) => tx.dismissedBy === rule.id)}
                  showAccount={showAccount}
                  canEdit={canEdit}
                  columns={columns}
                />
              ))
            : null}
        </TableBody>
      </Table>
    </section>
  );
}

/** One dismissal's caption row, followed by the holds it hides. */
function DismissedGroup({
  rule,
  rows,
  showAccount,
  canEdit,
  columns,
}: {
  rule: DismissalView;
  rows: DismissedPendingItem[];
  showAccount: boolean;
  canEdit: boolean;
  columns: number;
}) {
  const path = useRelativePath();
  const [isPending, startTransition] = useTransition();

  return (
    <>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={columns} className="pt-5">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="opacity-50">Dismissed:</span>
            <span className={CHIP}>{rule.connectionName}</span>
            {rule.tokens.map((token) => (
              <span key={token} className={CHIP}>
                {token}
              </span>
            ))}
            {canEdit ? (
              <button
                type="button"
                disabled={isPending}
                onClick={() => startTransition(() => restorePending(rule.id, path))}
                className="ml-1 opacity-70 underline-offset-2 transition-opacity hover:opacity-100 hover:underline disabled:opacity-40"
              >
                Show again
              </button>
            ) : null}
          </div>
        </TableCell>
      </TableRow>
      {rows.map((tx) => (
        <PendingRow key={tx.id} tx={tx} showAccount={showAccount} canEdit={canEdit} muted />
      ))}
    </>
  );
}

function PendingRow({
  tx,
  showAccount,
  canEdit,
  muted = false,
}: {
  tx: PendingTransactionItem;
  showAccount: boolean;
  /** Whether the actions column exists at all — it does not for a viewer. */
  canEdit: boolean;
  /** An already-dismissed row: shown faintly, and with nothing to press. It is
   *  undone through the rule above it, which covers rows besides this one. */
  muted?: boolean;
}) {
  const link = "underline underline-offset-2";

  return (
    <TableRow className={muted ? "opacity-50" : undefined}>
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
                  <Image
                    src={tx.account.connection.logo}
                    alt=""
                    width={16}
                    height={16}
                    loading="lazy"
                    decoding="async"
                    className="h-4 w-4 rounded object-contain"
                  />
                ) : null}
                <Link href={`/accounts/${tx.account.id}`} className={link}>
                  {accountLabel(tx.account)}
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

      {/* Kept even when empty: the header has this column, so a row that skipped
          it would shunt its amount under the wrong heading. */}
      {canEdit ? (
        <TableCell className="text-right">
          {muted ? null : <DismissButton pendingId={tx.id} description={tx.description} />}
        </TableCell>
      ) : null}
    </TableRow>
  );
}

/**
 * Hide this hold and the ones like it.
 *
 * "Dismiss" rather than "Delete" because nothing is deleted: the row stays, the
 * count above says how many are hidden, and one click brings them back. The
 * title spells out the part the button cannot — that this covers the next one
 * too, which is the whole point for a hold that reappears under a new id on
 * every sync.
 */
function DismissButton({ pendingId, description }: { pendingId: number; description: string }) {
  const path = useRelativePath();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => startTransition(() => dismissPending(pendingId, path))}
      title={`Stop showing this hold, and others like "${description}" from this bank`}
      className="text-xs opacity-60 underline-offset-2 transition-opacity hover:opacity-100 hover:underline disabled:opacity-40"
    >
      Dismiss
    </button>
  );
}
