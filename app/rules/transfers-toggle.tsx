"use client";

import { useTransition } from "react";
import { toggleTransfersAutoLink } from "./actions";

// A small on/off switch for the transfer auto-link rule. Optimistic-feeling: the
// action revalidates the page, so `enabled` (from the server) is the source of
// truth; while the write is in flight the control is disabled.
export function TransfersToggle({ enabled }: { enabled: boolean }) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Auto-link transfers"
      disabled={isPending}
      onClick={() => startTransition(() => toggleTransfersAutoLink(!enabled))}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        enabled ? "bg-status-good" : "bg-current/20"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform ${
          enabled ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
