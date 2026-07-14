import type { BalanceSummary } from "./balance";
import type { SpendSummary } from "./spend";

// The two runways the dashboard reads as a pair, both derived from a
// {@link BalanceSummary} and a {@link SpendSummary} rather than the database — pure
// functions the page composes from the summaries it already loaded.

/**
 * Months of liquid cash at a typical month's essential spend.
 *
 * Optimistic by construction: essential spend counts only *categorised*
 * transactions, and undrawn credit is deliberately excluded from the numerator
 * because available credit is not savings.
 */
export function runwayMonths(balances: BalanceSummary, spend: SpendSummary): number | null {
  if (!spend.medianEssential) return null;
  return balances.liquid / spend.medianEssential;
}

/**
 * Months of liquid cash if life carries on unchanged — a "life goes on" forecast
 * to sit beside the essentials-only {@link runwayMonths}. The denominator is *net*
 * burn: the forecast spend less the periodic income (wages, a benefit, ongoing
 * support) that keeps arriving to cover it, so this answers "how long must liquid
 * savings top up the shortfall". Optimistic in the same way as its neighbour: the
 * burn is built from categorised spend only, and irregular lumps are excluded on
 * both sides.
 *
 * Returns `Infinity` when forecast income covers the burn outright — the shortfall
 * is zero, so no topups are ever needed — and `null` only when there is no
 * spending history to forecast from at all.
 */
export function forecastRunwayMonths(
  balances: BalanceSummary,
  spend: SpendSummary,
): number | null {
  if (spend.forecastBurn == null) return null;
  const netBurn = spend.forecastBurn - spend.forecastIncome;
  if (netBurn <= 0) return Infinity;
  return balances.liquid / netBurn;
}
