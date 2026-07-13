"use client";

import { useTransition } from "react";
import { acceptAkahuValue, keepUserValue } from "./actions";

/**
 * Shown under an enrichment field when a sync found Akahu asserting a different
 * value than the one the user set. The field keeps the user's value until they
 * choose here: keep it (dismiss), or hand ownership back to Akahu (accept).
 */
export function ConflictBanner({
  conflictId,
  field,
  userLabel,
  akahuLabel,
}: {
  conflictId: number;
  field: "category" | "merchant";
  userLabel: string | null;
  akahuLabel: string | null;
}) {
  const [pending, startTransition] = useTransition();

  const dash = <span className="opacity-50">none</span>;

  return (
    <div
      role="status"
      className="w-full rounded border border-status-warning/40 bg-status-warning/10 px-2.5 py-2 text-xs"
    >
      <p className="text-secondary">
        A sync found a different {field}. You set{" "}
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
          Keep mine
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
