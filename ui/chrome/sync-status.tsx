"use client";

import { useTransition } from "react";
import { refreshAndSync } from "@/app/actions";
import { formatDateTime } from "@/lib/format";

type SyncStatusProps = {
  lastSync: { finishedAt: Date | null } | null;
  label?: string;
};

export function SyncStatus({ lastSync, label = "Synced" }: SyncStatusProps) {
  const [isPending, startTransition] = useTransition();

  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted">
      {lastSync?.finishedAt ? `${label} ${formatDateTime(lastSync.finishedAt)}` : "Never synced"}
      <button
        type="button"
        onClick={() => startTransition(() => refreshAndSync())}
        disabled={isPending}
        className="inline-flex items-center gap-1 text-foreground underline underline-offset-2 opacity-80 transition-opacity hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Refresh data from Akahu"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`size-3.5 ${isPending ? "animate-spin" : ""}`}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M8 3a5 5 0 1 0 4.546 2.914.75.75 0 0 1 1.313-1.248A6.5 6.5 0 1 1 8 1.5V0h1.25a.75.75 0 0 1 0 1.5H6.75a.75.75 0 0 1 0-1.5H8V3Z"
            clipRule="evenodd"
          />
        </svg>
        {isPending ? "Refreshing…" : "Refresh"}
      </button>
    </span>
  );
}
