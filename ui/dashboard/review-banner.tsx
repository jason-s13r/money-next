import Link from "next/link";
import { formatMoneyWhole } from "@/lib/format";

// The dashboard's uncategorised-spending callout. Surfacing the count is the
// point: a total that admits how much of itself is still unaccounted for is more
// honest than one that quietly folds the remainder in. Renders nothing when there
// is nothing to review.

export function ReviewBanner({
  rows,
  threshold,
  overThreshold,
  displayCurrency,
  unknownGroups,
}: {
  rows: number;
  threshold: number | null;
  overThreshold: number;
  displayCurrency: string;
  unknownGroups: string[];
}) {
  if (rows === 0) return null;

  return (
    <section className="mb-8 rounded-lg border border-status-warning/40 bg-status-warning/5 p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <span className="inline-block size-2 shrink-0 rounded-full bg-status-warning" />
        <Link href="/categories/uncategorised" className="underline underline-offset-2">
          {rows.toLocaleString("en-NZ")} uncategorised transactions
        </Link>
      </p>
      {threshold !== null && overThreshold > 0 && overThreshold < rows ? (
        <p className="mt-1 text-sm text-secondary">
          {overThreshold === 1
            ? "One is"
            : `The largest ${overThreshold.toLocaleString("en-NZ")} are`}{" "}
          {formatMoneyWhole(threshold, displayCurrency)} or more — worth categorising first.
        </p>
      ) : null}
      {unknownGroups.length > 0 ? (
        <p className="mt-2 text-sm text-secondary">
          NZFCC returned {unknownGroups.length} category group(s) this app doesn&apos;t know:{" "}
          {unknownGroups.join(", ")}. They count as discretionary, which inflates the runway
          above. Add them to{" "}
          <code className="font-mono text-xs">lib/categories.ts</code>.
        </p>
      ) : null}
    </section>
  );
}
