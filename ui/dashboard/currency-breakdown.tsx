import { formatMoneyWhole } from "@/lib/format";

// Multi-currency holdings, kept to a terse right-aligned indicator beside the
// dashboard headline rather than a full tile — the totals above already fold
// these into one number, so this is only a reminder of the spread. Renders
// nothing when every balance is already in the display currency.

export function CurrencyBreakdown({
  byCurrency,
  displayCurrency,
}: {
  byCurrency: { currency: string; total: number }[];
  displayCurrency: string;
}) {
  const hasForeign = byCurrency.some((b) => b.currency !== displayCurrency);
  if (!hasForeign) return null;

  return (
    <ul className="shrink-0 space-y-0.5 text-right text-xs font-mono tabular-nums">
      <li>Current Balances</li>
      {byCurrency.map((b) => (
        <li key={b.currency}>
          <span className="text-secondary">{formatMoneyWhole(b.total, b.currency)}</span>{" "}
          <span className="text-muted">{b.currency}</span>
        </li>
      ))}
    </ul>
  );
}
