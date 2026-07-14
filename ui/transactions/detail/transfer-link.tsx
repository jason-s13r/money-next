"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { TransferCandidate, TransferLeg } from "@/lib/server/matching";
import { formatDate, formatMoney } from "@/lib/format";
import { positiveAmountClass } from "@/lib/ui/amount";
import {
  linkTransfer,
  searchTransferCandidates,
  type TransferSearchResult,
  unlinkTransfer,
} from "@/app/transactions/[transactionId]/actions";

const btn =
  "rounded border border-current/25 px-2.5 py-1 text-xs hover:border-current/50 disabled:opacity-50";

/**
 * One row in a transfer table — a candidate, a search hit, whichever. A date that
 * links to the row's page, the merchant/description with the account (and an
 * optional note) beneath, the amount (with an optional converted value), and a
 * Link button. The two tables below differ only in which extras they pass.
 */
function CandidateRow({
  tx,
  note,
  converted,
  convertedCurrency,
  disabled,
  onLink,
  linkLabel,
}: {
  tx: {
    id: string;
    date: Date;
    amount: number;
    description: string;
    merchantName: string | null;
    account: { name: string; currency: string | null };
  };
  /** A qualifier under the account line — "conversion", "$0.76 fee". */
  note?: string;
  /** The amount expressed in the source currency, shown beneath the raw amount. */
  converted?: number | null;
  convertedCurrency?: string | null;
  disabled: boolean;
  onLink: (targetId: string) => void;
  linkLabel?: string;
}) {
  return (
    <tr className="border-b border-current/10">
      <td className="py-2 pr-4 whitespace-nowrap opacity-60">
        <Link href={`/transactions/${tx.id}`} className="underline underline-offset-2">
          {formatDate(tx.date)}
        </Link>
      </td>
      <td className="py-2 pr-4">
        {tx.merchantName ?? tx.description}
        <span className="block text-xs opacity-60">
          {tx.account.name}
          {note ? ` · ${note}` : ""}
        </span>
      </td>
      <td className={`py-2 pr-4 text-right font-mono tabular-nums ${positiveAmountClass(tx.amount)}`}>
        {formatMoney(tx.amount, tx.account.currency)}
        {converted != null ? (
          <span className="block text-xs font-normal opacity-60">
            ≈ {formatMoney(converted, convertedCurrency ?? null)}
          </span>
        ) : null}
      </td>
      <td className="py-2 pl-4 text-right">
        <button type="button" disabled={disabled} onClick={() => onLink(tx.id)} className={btn}>
          {linkLabel ?? "Link"}
        </button>
      </td>
    </tr>
  );
}

// Below this the legs of a currency are treated as cancelling exactly; above it
// the leftover is a fee one side skimmed (see `getTransferCandidates`).
const FEE_EPSILON = 0.005;

/**
 * The transfer section on a transaction's page, with two faces:
 *
 * - Once grouped, the other legs are *always* shown — a settled fact about the
 *   transaction — each with its own Unlink, and any same-currency residual (a
 *   skimmed fee) noted. A collapsed "Add another leg" sits beneath for a third.
 * - While unlinked, everything lives in one collapsed disclosure so it stays out
 *   of the way next to the similar-transactions list: the likely counterparties
 *   (see `getTransferCandidates`) plus a free-text search to hand-pick a leg the
 *   heuristics can't find — a cross-institution, cross-currency transfer whose
 *   legs share neither amount nor timestamp nor wording.
 */
export function TransferLink({
  sourceId,
  sourceAmount,
  sourceCurrency,
  legs,
  candidates,
}: {
  sourceId: string;
  sourceAmount: number;
  sourceCurrency: string | null;
  legs: TransferLeg[];
  candidates: TransferCandidate[];
}) {
  const [pending, startTransition] = useTransition();

  // The residual a same-currency transfer didn't cancel is its fee. Only meaningful
  // when every leg shares one currency; a cross-currency conversion has no single
  // net to call a fee, so leave it null there rather than mislabel the lone side.
  const singleCurrency = legs.every((l) => l.account.currency === sourceCurrency);
  const residual = singleCurrency
    ? sourceAmount + legs.reduce((sum, l) => sum + l.amount, 0)
    : null;

  const linkAction = (targetId: string) =>
    startTransition(() => linkTransfer(sourceId, targetId));

  return (
    <section className="mb-8">
      {legs.length > 0 ? (
        <>
          <h2 className="mb-3 flex items-baseline justify-between gap-3 border-b border-current/20 pb-2 text-sm font-medium opacity-60">
            <span>Transfer</span>
            {residual !== null && Math.abs(residual) >= FEE_EPSILON ? (
              <span className="tabular-nums">
                {formatMoney(Math.abs(residual), sourceCurrency)} fee
              </span>
            ) : null}
          </h2>
          <ul className="mb-4 flex flex-col gap-2">
            {legs.map((leg) => (
              <li key={leg.id} className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <Link
                    href={`/transactions/${leg.id}`}
                    className="underline underline-offset-2"
                  >
                    {leg.merchantName ?? leg.description}
                  </Link>
                  <span className="text-xs opacity-60">
                    {formatDate(leg.date)} · {leg.account.name}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`font-mono tabular-nums ${positiveAmountClass(leg.amount)}`}>
                    {formatMoney(leg.amount, leg.account.currency)}
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => startTransition(() => unlinkTransfer(leg.id))}
                    className={btn}
                  >
                    Unlink
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b border-current/20 pb-2 text-sm font-medium opacity-60 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-1.5">
            <span className="transition-transform group-open:rotate-90">›</span>
            {legs.length > 0
              ? "Add another leg"
              : candidates.length > 0
                ? "Possible transfers"
                : "Link a transfer"}
          </span>
          {candidates.length > 0 ? (
            <span className="tabular-nums">{candidates.length}</span>
          ) : null}
        </summary>

        {candidates.length > 0 ? (
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-current/20 text-left">
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">Description</th>
                <th className="py-2 pr-4 text-right font-medium">Amount</th>
                <th className="py-2 pl-4" />
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <CandidateRow
                  key={c.id}
                  tx={c}
                  // A cross-currency leg is flagged as such; a same-currency one
                  // notes any residual the two sides didn't cancel — a skimmed fee.
                  note={
                    c.kind === "conversion" && c.converted === null
                      ? "conversion"
                      : c.kind === "amount" &&
                          c.delta !== null &&
                          Math.abs(c.delta) >= FEE_EPSILON
                        ? `${formatMoney(Math.abs(c.delta), c.account.currency)} fee`
                        : undefined
                  }
                  converted={c.converted}
                  convertedCurrency={sourceCurrency}
                  disabled={pending}
                  onLink={linkAction}
                  linkLabel="Link as transfer"
                />
              ))}
            </tbody>
          </table>
        ) : null}

        <ManualLink sourceId={sourceId} onLink={linkAction} disabled={pending} />
      </details>
    </section>
  );
}

/**
 * Free-text search for a transfer leg the automatic candidates miss, and a Link
 * button on each hit. Kept deliberately manual (a Search button, not
 * search-as-you-type) so it stays a cheap, on-demand escape hatch rather than a
 * query on every keystroke.
 */
function ManualLink({
  sourceId,
  onLink,
  disabled,
}: {
  sourceId: string;
  onLink: (targetId: string) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TransferSearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, startSearch] = useTransition();

  function search(event: React.FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    startSearch(async () => {
      setResults(await searchTransferCandidates(sourceId, q));
      setSearched(true);
    });
  }

  return (
    <form onSubmit={search} className="mt-4">
      <div className="flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a transaction to link…"
          aria-label="Search a transaction to link as a transfer"
          className="flex-1 rounded border border-current/25 bg-transparent px-2 py-1 text-sm"
        />
        <button type="submit" disabled={searching || query.trim().length < 2} className={btn}>
          Search
        </button>
      </div>

      {results.length > 0 ? (
        <table className="mt-3 w-full border-collapse text-sm">
          <tbody>
            {results.map((r) => (
              <CandidateRow key={r.id} tx={r} disabled={disabled} onLink={onLink} />
            ))}
          </tbody>
        </table>
      ) : searched && !searching ? (
        <p className="mt-3 text-xs text-muted">No unlinked transactions match.</p>
      ) : null}
    </form>
  );
}
