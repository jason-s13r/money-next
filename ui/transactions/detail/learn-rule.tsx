"use client";

import { Link } from "@/ui/chrome/workspace-context";
import { useState, useTransition } from "react";
import { useCanEdit } from "@/ui/chrome/workspace-context";
import { generateRuleFromTransaction } from "@/app/w/[workspace]/rules/actions";
import type { GenerateRuleResult } from "@/app/w/[workspace]/rules/types";

/**
 * Promote this transaction's hand-set category/merchant into a durable rule: one
 * click derives a match predicate from its description and folds it into the
 * active decision graph, so future transactions that look like it are enriched
 * automatically on sync. The one-off "apply to similar" list nearby handles the
 * *past*; this handles the *future*.
 *
 * Shown only when there is something to learn — a category or merchant is set.
 */
export function LearnRule({
  transactionId,
  hasCategory,
  hasMerchant,
}: {
  transactionId: string;
  hasCategory: boolean;
  hasMerchant: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<GenerateRuleResult | null>(null);
  const canEdit = useCanEdit();

  if (!hasCategory && !hasMerchant) return null;
  // Nothing here is a read: the whole component exists to write a standing rule,
  // which is `enrichment.update` — not a viewer's to make.
  if (!canEdit) return null;

  const targets = [hasCategory && "category", hasMerchant && "merchant"]
    .filter(Boolean)
    .join(" and ");

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setResult(await generateRuleFromTransaction(transactionId));
            })
          }
          className="rounded border border-current/25 px-2.5 py-1 text-xs hover:border-current/50 disabled:opacity-50"
        >
          {pending ? "Creating rule…" : `Create rule from this transaction`}
        </button>
        <span className="text-xs text-muted">
          Learns the {targets} for future transactions like this one.
        </span>
      </div>

      {result && !pending ? (
        result.ok ? (
          <div className="mt-3 rounded border border-status-good/30 bg-status-good/5 p-3 text-xs">
            <p className="font-medium text-status-good">
              {result.merged ? "Rule updated" : "Rule created"} — matches{" "}
              {result.matchCount.toLocaleString("en-NZ")} transaction
              {result.matchCount === 1 ? "" : "s"} now, and future ones like them.
            </p>
            <p className="mt-1 text-muted">
              When{" "}
              {result.tokens.map((t, i) => (
                <span key={t}>
                  {i > 0 ? " + " : ""}
                  <code className="rounded bg-current/10 px-1">{t}</code>
                </span>
              ))}{" "}
              →{" "}
              {[result.categoryName, result.merchantName].filter(Boolean).join(" · ")}
            </p>
            <Link
              href="/rules"
              className="mt-1 inline-block underline underline-offset-2"
            >
              Manage rules →
            </Link>
          </div>
        ) : (
          <p className="mt-3 rounded border border-status-critical/30 bg-status-critical/5 p-3 text-xs text-status-critical">
            {result.reason}
          </p>
        )
      ) : null}
    </div>
  );
}
