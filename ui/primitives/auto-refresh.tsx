"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Poll the server while a background job is in flight (phase 7).
 *
 * A queued sync or rules backfill is finished by the `money_sync` worker in
 * another process, which can't reach into Next's cache to revalidate the page when
 * it's done. So the page pulls: while `active`, ask the router to re-render every
 * few seconds — the page's reads are dynamic, so a refresh re-queries and the row
 * moves to `success`/`failed` on its own. When nothing is pending, `active` is
 * false and the interval never starts, so a settled history page is inert.
 */
export function AutoRefresh({ active, intervalMs = 3000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);

  return null;
}
