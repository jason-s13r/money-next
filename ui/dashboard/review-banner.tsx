import { Link } from "@/ui/chrome/workspace-context";
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
}: {
  rows: number;
  threshold: number | null;
  overThreshold: number;
  displayCurrency: string;
}) {
  if (rows === 0) return null;

  return (
    <section className="rounded-lg border border-status-warning/40 bg-status-warning/5 p-2">
      <p className="flex items-center gap-2 text-sm font-medium">
        <span className="inline-block size-2 shrink-0 rounded-full bg-status-warning" />

        <Link
          href="/categories/uncategorised?sort=amount-desc"
          className="underline underline-offset-2"
        >
          {rows.toLocaleString("en-NZ")} uncategorised transactions
        </Link>

        {threshold !== null && overThreshold > 0 && overThreshold < rows ? (
          <span className="text-sm text-muted">
            {overThreshold === 1
              ? "One is"
              : `The largest ${overThreshold.toLocaleString("en-NZ")} are`}{" "}
            {formatMoneyWhole(threshold, displayCurrency)} or more — worth categorising first.
          </span>
        ) : null}
      </p>
    </section>
  );
}
