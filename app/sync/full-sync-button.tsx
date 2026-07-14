"use client";

import { useTransition } from "react";
import { fullSync } from "../actions";

export function FullSyncButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={() => startTransition(() => fullSync())}
      className="flex items-center"
    >
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Run a full historical sync"
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
        {isPending ? "Syncing…" : "Full sync"}
      </button>
    </form>
  );
}
