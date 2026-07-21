import type { BalanceSummary } from "./balance";
import type { SpendSummary } from "./spend";

// The three runways the dashboard reads as a set, all derived from a
// {@link BalanceSummary} and a {@link SpendSummary} rather than the database — pure
// functions the page composes from the summaries it already loaded.

export type Runway = {
  /** Scenario name — matches the chart legend. */
  label: string;
  /** CSS colour token, kept in sync with the chart line for this scenario. */
  color: string;
  /** Months until liquid balance hits zero at this burn, or null / Infinity. */
  months: number | null;
  /** Monthly burn that produced the runway, in display currency. */
  monthlyBurn: number | null;
  /** Pre-built runway phrase, e.g. "12.5 months runway". */
  runwayText: string;
  /** Pre-formatted burn figure the runway ran at, e.g. "$3,400/mo" or "—". */
  burnText: string;
  /**
   * The forecast income and expenses that net to {@link burnText}, each
   * pre-formatted, so the tile can show the arithmetic behind the net burn in a
   * tooltip. Null when there is no forecast (no spending history).
   */
  burnBreakdown: { expenses: string; income: string; net: string } | null;
  /** Status derived from the conventional 6/3-month runway thresholds. */
  status: "good" | "warning" | "critical" | null;
};

/** Six months of essential spend in the bank is the conventional line. */
function runwayStatus(months: number): "good" | "warning" | "critical" {
  if (months >= 6) return "good";
  if (months >= 3) return "warning";
  return "critical";
}

function formatMonths(months: number | null): { text: string; status: ReturnType<typeof runwayStatus> | null } {
  if (months === null) return { text: "No data", status: null };
  if (months === Infinity) return { text: "Sustained", status: "good" };
  return { text: `${months.toFixed(1)} months`, status: runwayStatus(months) };
}

/**
 * All three runway scenarios the dashboard surfaces: the essentials-only
 * emergency floor, the "life goes on" forecast net of periodic income, and the
 * pessimistic gross forecast with no income offset. Each carries its chart colour
 * and a pre-formatted label so callers don't build strings in JSX.
 */
export function getRunways(
  balances: BalanceSummary,
  spend: SpendSummary,
  formatMoney: (amount: number) => string,
): Runway[] {
  const forecastMonthly =
    spend.forecastBurn === null ? null : spend.forecastBurn - spend.forecastIncome;

  const forecastMonths =
    forecastMonthly === null || forecastMonthly <= 0
      ? forecastMonthly === null
        ? null
        : Infinity
      : balances.liquid / forecastMonthly;

  const make = (
    label: string,
    color: string,
    months: number | null,
    monthlyBurn: number | null,
    breakdown: { expenses: number; income: number } | null,
  ): Runway => {
    const formatted = formatMonths(months);
    const burnText = monthlyBurn !== null ? `${formatMoney(monthlyBurn)}/mo` : "—";
    return {
      label,
      color,
      months,
      monthlyBurn,
      status: formatted.status,
      runwayText: `${formatted.text} runway`,
      burnText,
      burnBreakdown:
        breakdown === null
          ? null
          : {
              expenses: `${formatMoney(breakdown.expenses)}/mo`,
              income: `${formatMoney(breakdown.income)}/mo`,
              net: burnText,
            },
    };
  };

  return [
    make(
      "Forecast",
      "var(--viz-1)",
      forecastMonths,
      forecastMonthly,
      spend.forecastBurn === null
        ? null
        : { expenses: spend.forecastBurn, income: spend.forecastIncome },
    ),
  ];
}

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
