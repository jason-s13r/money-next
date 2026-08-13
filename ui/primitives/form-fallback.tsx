import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Stand-in for a form while whatever it waits on resolves — a session gate, a
 * search param. Shaped like the real thing (a labelled field per row, then the
 * submit) so the streamed form replaces it without the page jumping, which a
 * bare spinner would not.
 *
 * `aria-hidden` because it says nothing a screen reader wants: the heading above
 * it has already been announced, and the real form arrives moments later.
 */
export function FormFallback({ fields, className }: { fields: number; className?: string }) {
  return (
    <div className={cn("mt-6 flex flex-col gap-3", className)} aria-hidden>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="flex flex-col gap-1">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
      <Skeleton className="mt-2 h-9 w-32" />
    </div>
  );
}
