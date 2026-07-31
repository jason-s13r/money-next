import type { ProjectionScenario } from "./budget/forecast";

// The runway tiles under the balance — one per forecast budget, read straight
// off the projections the chart draws.
//
// It used to divide a balance by a flat monthly burn. It no longer computes a
// runway at all: the projection already walked the plan forward day by day and
// found the date the money runs out, and asking the same question twice is how
// the tile and the line end up disagreeing. This is now formatting.
//
// Two consequences worth knowing. The figure a scenario depletes is the
// *accessible* balance, where the old tile used the liquid one — the accessible
// figure is what the chart's history line ends at, and a tile that starts from a
// different number than the line it labels is just wrong. And a scenario built
// from budgets runs at the plan's own rhythm, so "months" is where the walk
// actually crossed zero rather than a division: a Christmas in the way moves it.

export type Runway = {
  /** Scenario name — matches the chart legend. */
  label: string;
  /** CSS colour token, kept in sync with the chart line for this scenario. */
  color: string;
  /** Months until the balance hits zero, or null / Infinity. */
  months: number | null;
  /** Monthly net burn behind it, in display currency. Positive burns down. */
  monthlyBurn: number | null;
  /** The NZ day the projection crosses zero, or null if it never does. */
  depletionDay: string | null;
  /** Pre-built runway phrase, e.g. "12.5 months, empty by 3 Aug 2027". */
  runwayText: string;
  /** Pre-built burn phrase, e.g. "burning $3,400/mo" or "$820/mo to spare". */
  burnText: string;
  /**
   * The planned income and expenses that net to {@link burnText}, each
   * pre-formatted, so the tile can show the arithmetic behind the net burn in a
   * tooltip. Null when no income is counted, where the net *is* the expenses and
   * a breakdown would only restate it.
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

const dayFmt = new Intl.DateTimeFormat("en-NZ", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** `YYYY-MM-DD` → "3 Aug 2027". Read as UTC, which is how the projection wrote
 *  it: NZ calendar days are carried as UTC midnight throughout. */
function formatDay(day: string): string {
  return dayFmt.format(new Date(`${day}T00:00:00Z`));
}

function describe(months: number | null, depletionDay: string | null) {
  if (months === null) return { text: "No data", status: null };
  if (months === Infinity) {
    // Not "a very long runway" — an unbounded one. The plan pays for itself.
    return { text: "Sustained — nothing to deplete", status: "good" as const };
  }
  const status = runwayStatus(months);
  // The date is the better answer and leads; the months figure stays because it
  // is what the 6/3-month convention is judged against.
  return {
    text: depletionDay
      ? `${months.toFixed(1)} months, empty by ${formatDay(depletionDay)}`
      : `${months.toFixed(1)} months runway`,
    status,
  };
}

/**
 * One runway per forecast budget, in the order the chart draws them.
 *
 * Takes the projections rather than the summaries because the projections are
 * the answer: `getBalanceSeries` has already built them (from the workspace's
 * own forecast budgets, or from the flat history-derived fallback), and passing
 * them in is what keeps every tile agreeing with the line above it.
 */
export function getRunways(
  scenarios: ProjectionScenario[],
  formatMoney: (amount: number) => string,
): Runway[] {
  return scenarios.map((scenario) => {
    const described = describe(scenario.months, scenario.depletionDay);
    // A plan can net out either way, and a scenario layering a wage often does.
    // "burn rate −$1,831/mo" is a double negative nobody should have to parse:
    // a negative burn is money left over, so it says that instead.
    const burnText =
      scenario.monthlyBurn === null
        ? "—"
        : scenario.monthlyBurn >= 0
          ? `burning ${formatMoney(scenario.monthlyBurn)}/mo`
          : `${formatMoney(-scenario.monthlyBurn)}/mo to spare`;

    return {
      label: scenario.name,
      color: scenario.color,
      months: scenario.months,
      monthlyBurn: scenario.monthlyBurn,
      depletionDay: scenario.depletionDay,
      status: described.status,
      runwayText: described.text,
      burnText,
      burnBreakdown:
        scenario.monthlyIn > 0
          ? {
              expenses: `${formatMoney(scenario.monthlyOut)}/mo`,
              income: `${formatMoney(scenario.monthlyIn)}/mo`,
              net: burnText,
            }
          : null,
    };
  });
}
