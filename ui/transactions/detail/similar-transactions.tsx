"use client";

import { Link, useCanEdit } from "@/ui/chrome/workspace-context";
import { useState, useTransition } from "react";
import type { SimilarTransaction } from "@/lib/server/matching/matching";
import { formatDate, formatMoney } from "@/lib/format";
import { positiveAmountClass } from "@/lib/ui/amount";
import { applyCategoryToTransactions } from "@/app/w/[workspace]/transactions/[transactionId]/actions/category";
import { applyMerchantToTransactions } from "@/app/w/[workspace]/transactions/[transactionId]/actions/merchant";

/**
 * The list of transactions that look like the one on screen (see
 * `getSimilarTransactions`), with checkboxes so the category or merchant just set
 * here can be pushed onto the whole recurring set — every salary deposit at once,
 * say — rather than one row at a time.
 *
 * Selection starts with every row ticked; the apply buttons act on whatever is
 * ticked. They only appear for a field the source row actually has set, since
 * there is nothing to copy otherwise. After an apply the page revalidates and the
 * rows re-render showing their new values.
 *
 * For a `viewer` the table stays and the machinery goes: no checkboxes, no apply
 * buttons. The list is a genuine read — these are the rows related to the one on
 * screen, each a link — and it answers "what else looks like this?" for someone
 * who will never change any of them. Only the selecting and applying is an
 * enrichment write, so only that is withheld.
 */
export function SimilarTransactions({
  sourceId,
  items,
  category,
  merchant,
}: {
  sourceId: string;
  items: SimilarTransaction[];
  category: { id: string; name: string } | null;
  merchant: { id: string; name: string } | null;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(items.map((t) => t.id)));
  const [pending, startTransition] = useTransition();
  const canEdit = useCanEdit();

  if (items.length === 0) return null;

  const selectedIds = items.map((t) => t.id).filter((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((t) => t.id)),
    );
  }

  const btn =
    "rounded border border-current/25 px-2.5 py-1 text-xs hover:border-current/50 disabled:opacity-50";

  return (
    <section className="mb-8">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b border-current/20 pb-2 text-sm font-medium opacity-60 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-1.5">
            <span className="transition-transform group-open:rotate-90">›</span>
            Similar transactions
          </span>
          <span className="tabular-nums">
            {canEdit ? `${selectedIds.length} of ${items.length} selected` : `${items.length}`}
          </span>
        </summary>

        <div className="mt-3">
      {!canEdit ? null : category || merchant ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {category ? (
            <button
              type="button"
              disabled={pending || selectedIds.length === 0}
              onClick={() =>
                startTransition(() =>
                  applyCategoryToTransactions(sourceId, category.id, selectedIds),
                )
              }
              className={btn}
            >
              Set category to {category.name}
            </button>
          ) : null}
          {merchant ? (
            <button
              type="button"
              disabled={pending || selectedIds.length === 0}
              onClick={() =>
                startTransition(() =>
                  applyMerchantToTransactions(sourceId, merchant.id, selectedIds),
                )
              }
              className={btn}
            >
              Set merchant to {merchant.name}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mb-3 text-xs text-muted">
          Set a category or merchant above to apply it to these.
        </p>
      )}

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-current/20 text-left">
            {canEdit ? (
              <th className="py-2 pr-3">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={selected.size === items.length}
                  onChange={toggleAll}
                />
              </th>
            ) : null}
            <th className="py-2 pr-4 font-medium">Date</th>
            <th className="py-2 pr-4 font-medium">Description</th>
            <th className="py-2 pr-4 font-medium">Category</th>
            <th className="py-2 pl-4 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((tx) => (
            <tr key={tx.id} className="border-b border-current/10">
              {canEdit ? (
                <td className="py-2 pr-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${tx.description}`}
                    checked={selected.has(tx.id)}
                    onChange={() => toggle(tx.id)}
                  />
                </td>
              ) : null}
              <td className="py-2 pr-4 whitespace-nowrap opacity-60">
                <Link
                  href={`/transactions/${tx.id}`}
                  className="underline underline-offset-2"
                >
                  {formatDate(tx.date)}
                </Link>
              </td>
              <td className="py-2 pr-4">{tx.merchant?.name ?? tx.description}</td>
              <td className="py-2 pr-4 opacity-60">{tx.category?.name ?? "—"}</td>
              <td className={`py-2 pl-4 text-right font-mono tabular-nums ${positiveAmountClass(tx.amount)}`}>
                {formatMoney(tx.amount, tx.account.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
        </div>
      </details>
    </section>
  );
}
