"use client";

import { useTransition } from "react";
import { acceptAkahuValue, keepUserValue } from "@/app/transactions/[transactionId]/actions/conflict";

/**
 * Shown under an enrichment field when a sync found Akahu asserting a different
 * value than the one being held. The field keeps the held value until the reader
 * chooses here: keep it (dismiss), or take Akahu's (accept).
 *
 * The wording follows `heldSource`, because "you set this" and "your rule set
 * this" are different situations with different fixes — one is a decision you
 * made about this row, the other is a standing instruction misfiring on it, and
 * telling the reader the first when it was the second sends them looking for an
 * edit they never made.
 */
export function ConflictBanner({
  conflictId,
  field,
  heldSource,
  userLabel,
  akahuLabel,
}: {
  conflictId: number;
  field: "category" | "merchant";
  heldSource: string;
  userLabel: string | null;
  akahuLabel: string | null;
}) {
  const [pending, startTransition] = useTransition();

  const dash = <span className="opacity-50">none</span>;
  const byRule = heldSource === "rule";

  return (
    <div
      role="status"
      className="w-full rounded border border-status-warning/40 bg-status-warning/10 px-2.5 py-2 text-xs"
    >
      <p className="text-secondary">
        A sync found a different {field}. {byRule ? "Your rules set" : "You set"}{" "}
        <span className="font-medium text-foreground">{userLabel ?? dash}</span>; Akahu now
        reports <span className="font-medium text-foreground">{akahuLabel ?? dash}</span>.
      </p>
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => keepUserValue(conflictId))}
          className="rounded border border-current/25 px-2 py-0.5 hover:border-current/50 disabled:opacity-50"
        >
          {byRule ? "Keep the rule's" : "Keep mine"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => acceptAkahuValue(conflictId))}
          className="rounded border border-current/25 px-2 py-0.5 hover:border-current/50 disabled:opacity-50"
        >
          Use Akahu&rsquo;s
        </button>
      </div>
    </div>
  );
}
