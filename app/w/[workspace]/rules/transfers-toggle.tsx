"use client";

import { useTransition } from "react";
import { toggleTransfersAutoLink } from "./actions";
import { useCanEdit } from "@/ui/chrome/workspace-context";

// A small on/off switch for the transfer auto-link rule. Optimistic-feeling: the
// action revalidates the page, so `enabled` (from the server) is the source of
// truth; while the write is in flight the control is disabled.
//
// A viewer gets the state as a word instead of a switch. Unlike the other
// controls this one *is* information — whether transfers auto-link explains why
// the ledger looks the way it does — so it reads out rather than disappearing. A
// disabled switch would have done neither job: it still looks like a thing to
// press, and greyed-out reads as "not right now" rather than "not yours".
export function TransfersToggle({ enabled }: { enabled: boolean }) {
  const [isPending, startTransition] = useTransition();
  const canEdit = useCanEdit();

  if (!canEdit) {
    return (
      <span className="rounded bg-current/10 px-1.5 py-0.5 text-xs">
        {enabled ? "On" : "Off"}
      </span>
    );
  }

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
