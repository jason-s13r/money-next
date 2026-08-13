import { Skeleton } from "@/components/ui/skeleton";

/**
 * Device rows in the same bordered, divided list the real one renders into,
 * held while the session read behind the boundary resolves. Three rows because
 * it only has to occupy the space plausibly, not predict the count.
 */
export function SessionListFallback({ rows = 3 }: { rows?: number }) {
  return (
    <div className="mt-6 flex flex-col gap-3" aria-hidden>
      <ul className="flex flex-col divide-y divide-current/10 rounded-lg border border-current/10">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex items-center justify-between gap-4 p-3">
            <div className="min-w-0">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="mt-1.5 h-3 w-64" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
