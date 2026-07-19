"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Poll the server while a run is in flight (phase 7).
 *
 * A queued sync is finished by the `money_sync` worker in another process, which
 * can't reach into Next's cache to revalidate this page when it's done. So the
 * page pulls: while any run is `queued` or `running`, ask the router to re-render
 * every few seconds — the page's reads are dynamic, so a refresh re-queries and
 * the row moves to `success`/`failed` on its own. When nothing is pending, `active`
 * is false and the interval never starts, so a settled history page is inert.
 */
export function SyncAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [active, router]);

  return null;
}
