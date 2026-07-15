"use client";

import { useState, useTransition } from "react";
import { applyRulesNow } from "./actions";
import type { RulesRunSummary } from "@/lib/server/rules/engine";

// Runs the active rules over the whole transaction history and reports what it
// changed. Styled to match the "Full sync" button on the sync page, since both are
// the same kind of run-a-batch primary action.
export function ApplyRulesButton({ disabled }: { disabled?: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [summary, setSummary] = useState<RulesRunSummary | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={disabled || isPending}
        onClick={() => startTransition(async () => setSummary(await applyRulesNow()))}
        className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        title={disabled ? "Add a rule first" : undefined}
        aria-label="Apply rules to all transactions now"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`size-4 ${isPending ? "animate-spin" : ""}`}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M8 3a5 5 0 1 0 4.546 2.914.75.75 0 0 1 1.313-1.248A6.5 6.5 0 1 1 8 1.5V0h1.25a.75.75 0 0 1 0 1.5H6.75a.75.75 0 0 1 0-1.5H8V3Z"
            clipRule="evenodd"
          />
        </svg>
        {isPending ? "Applying…" : "Apply rules"}
      </button>
      {summary && !isPending ? (
        <p className="text-xs text-muted">
          {summary.evaluated.toLocaleString("en-NZ")} evaluated · {summary.categorised}{" "}
          categorised · {summary.merchantsSet} merchants · {summary.transfersLinked} transfers
          {summary.errors ? ` · ${summary.errors} errored` : ""}
        </p>
      ) : null}
    </div>
  );
}
