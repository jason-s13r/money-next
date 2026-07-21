import { TriangleAlert } from "lucide-react";

import { Link } from "@/ui/chrome/workspace-context";
import { formatMoneyWhole } from "@/lib/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// The dashboard's uncategorised-spending callout. Surfacing the count is the
// point: a total that admits how much of itself is still unaccounted for is more
// honest than one that quietly folds the remainder in. Renders nothing when there
// is nothing to review. A shadcn Alert, tinted with the app's own warning token
// since the base Alert ships only default/destructive variants.

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
    <Alert className="border-status-warning/40 bg-status-warning/5 [&>svg]:text-status-warning">
      <TriangleAlert />
      <AlertTitle>
        <Link href="/transactions/uncategorised?sort=amount-desc">
          {rows.toLocaleString("en-NZ")} uncategorised transactions
        </Link>
      </AlertTitle>
      {threshold !== null && overThreshold > 0 && overThreshold < rows ? (
        <AlertDescription>
          {overThreshold === 1
            ? "One is"
            : `The largest ${overThreshold.toLocaleString("en-NZ")} are`}{" "}
          {formatMoneyWhole(threshold, displayCurrency)} or more — worth categorising first.
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
