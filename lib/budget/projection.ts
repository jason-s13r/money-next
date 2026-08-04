// Turning a plan's daily cash flows into a line, a depletion date and a rate.
// Pure: numbers in, numbers out, no database.

/** The average calendar month, for turning a daily walk into a monthly rate. */
export const DAYS_PER_MONTH = 365.25 / 12;

/** How far forward a scenario is walked: two years, so an annual bill shows up
 *  twice and reads as a rhythm rather than a one-off. */
export const PROJECTION_DAYS = 730;

/**
 * The palette forecast budgets are coloured from, in order. Derived from a
 * budget's position at read time, not stored on the row, so this is the single
 * source of truth for the projection engine and the UI legend.
 */
export const SCENARIO_COLORS = [
  "var(--viz-1)",
  "var(--viz-3)",
  "var(--viz-6)",
  "var(--viz-5)",
  "var(--viz-2)",
  "var(--viz-7)",
  "var(--viz-8)",
  "var(--viz-4)",
] as const;

/** The lowest balance a projection may be walked down to: zero, unless the
 *  workspace passes a negative credit floor. Stopping at the axis would draw the
 *  day the balance goes negative as if it were the day the money stops. */
export const NO_CREDIT_FLOOR = 0;

/**
 * A vertex of the projected balance line: `day` days from now, `worth` at its
 * end. One per *change*, not per day, which keeps two years to a few dozen points
 * and a flat rate to one. Fractional only on the vertex where a line bottoms out.
 */
export type ProjectionPoint = { day: number; worth: number };

export type ProjectionScenario = {
  id: string;
  name: string;
  /** The `--viz-*` token for this forecast's line, swatch and tile. */
  color: string;
  /** The line, oldest first. Implicitly starts at (0, the current balance). */
  points: ProjectionPoint[];
  /** The NZ day the balance first goes negative, or null within the horizon. */
  depletionDay: string | null;
  /** The NZ day the balance reaches the credit floor — every facility drawn to
   *  its limit, and the day the line stops. Null when the plan never gets there. */
  creditExhaustedDay: string | null;
  /** Months until that day. `Infinity` when income covers the plan; null only
   *  when there is nothing to project. Extrapolated at the average rate past the
   *  horizon — the shape stops being credible there, not the arithmetic. */
  months: number | null;
  /** Months the facility adds after that: balance hitting zero to credit hitting
   *  its limit. Kept apart from {@link months} — summing them would report a
   *  household spending its overdraft as healthier than one without. */
  creditMonths: number | null;
  /** Average monthly net outflow: positive burns the balance down. */
  monthlyBurn: number | null;
  /** The two halves of that net, both positive, for the tile and legend. */
  monthlyOut: number;
  monthlyIn: number;
  /** Days in the horizon no budget in this scenario was active for, and which
   *  therefore ran at the history-derived burn instead — a scenario 95% on the
   *  fallback is barely a budget projection. */
  blendedDays: number;
};

const DAY_MS = 86_400_000;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** A duration in the one form every runway figure is written in. Under a month
 *  is said in words: "0.4 months" is a decimal pretending to be a fact. */
export function formatMonths(months: number): string {
  if (months < 1) return "under a month";
  return `${months.toFixed(1)} months`;
}

/**
 * How long a scenario lasts, in the two phases a reader must keep apart: months
 * spent from the balance, then months spent on credit. Shared by the runway tile
 * and the chart legend so one scenario never gets described in two shapes.
 */
export function runwayPhases(
  scenario: Pick<ProjectionScenario, "months" | "creditMonths">,
): { label: string; value: string }[] {
  const { months, creditMonths } = scenario;
  // Nothing to phase: a plan that pays for itself never reaches either end.
  if (months === null || !Number.isFinite(months)) return [];

  const phases = [{ label: "Balance lasts", value: formatMonths(months) }];
  if (creditMonths !== null) {
    phases.push({ label: "Credit lasts", value: formatMonths(creditMonths) });
  }
  return phases;
}

/**
 * Each future day's planned net flow, averaged across every forecast budget.
 * Bars all root at $0, so one per budget would stack into a total nobody planned.
 * Days past a short scenario average only the scenarios that still reach them.
 */
export function averageDailyNets(perScenario: number[][]): number[] {
  const days = Math.max(0, ...perScenario.map((nets) => nets.length));
  const out = new Array<number>(days);
  for (let i = 0; i < days; i++) {
    let sum = 0;
    let n = 0;
    for (const nets of perScenario) {
      if (i >= nets.length) continue;
      sum += nets[i];
      n++;
    }
    // Whole cents: these are averages of already-approximate plans, and the
    // series ships to the browser a day at a time.
    out[i] = n === 0 ? 0 : Math.round((sum / n) * 100) / 100;
  }
  return out;
}

/**
 * A scenario's daily net flows into the line, the depletion date and the rates;
 * shared with the no-budget fallback so both use one piece of arithmetic. `floor`
 * moves only where the line *ends* — the runway is still measured to zero.
 */
export function walkProjection(
  nets: number[],
  outs: number[],
  ins: number[],
  currentWorth: number,
  from: Date,
  floor: number = NO_CREDIT_FLOOR,
): Pick<
  ProjectionScenario,
  | "points"
  | "depletionDay"
  | "creditExhaustedDay"
  | "months"
  | "creditMonths"
  | "monthlyBurn"
  | "monthlyOut"
  | "monthlyIn"
> {
  const days = nets.length;
  const scale = days === 0 ? 0 : DAYS_PER_MONTH / days;
  const monthlyOut = outs.reduce((a, b) => a + b, 0) * scale;
  const monthlyIn = ins.reduce((a, b) => a + b, 0) * scale;

  // Never above where the balance already is: a facility reported as drawn past
  // its own limit would otherwise put the floor above the start and draw the
  // whole projection upward out of nothing.
  const bottom = Math.min(floor, currentWorth);

  const points: ProjectionPoint[] = [];
  let worth = currentWorth;
  let depletionDay: string | null = null;
  /** The fractional day of the zero crossing, for the runway. Kept apart from
   *  the line's last vertex, which with a facility carries on past it. */
  let depletionAt: number | null = null;
  let creditExhaustedDay: string | null = null;
  /** The fractional day the line reached the floor, for the credit phase's own
   *  length. Null while the line is still going. */
  let bottomAt: number | null = null;
  /** The previous day's flow, for the collinearity test below. */
  let lastNet = Number.NaN;

  for (let i = 0; i < days; i++) {
    if (nets[i] === 0) continue;
    const before = worth;
    worth += nets[i];

    // Only the credit floor ends the line; this is the *first* zero crossing,
    // which is the runway. A plan that goes under in March, is rescued by a
    // bonus in June and goes under again in July ran out in March.
    if (depletionAt === null && worth <= 0 && before > 0) {
      depletionDay = isoDay(new Date(from.getTime() + i * DAY_MS));
      depletionAt = i + before / (before - worth);
    }

    // `>=` on the left, not `>`: mid-walk a day can only start above the floor,
    // so the equal case is one with no credit left to begin with — that line
    // starts on the floor rather than sinking through it.
    if (worth <= bottom && before >= bottom) {
      // Land the line on the floor rather than wherever the day's flow overshot
      // to: the crossing happens inside the day.
      const fraction = (before - bottom) / (before - worth);
      bottomAt = i + fraction;
      points.push({ day: bottomAt, worth: bottom });
      if (floor < NO_CREDIT_FLOOR) {
        creditExhaustedDay = isoDay(new Date(from.getTime() + i * DAY_MS));
      }
      break;
    }

    const point = { day: i + 1, worth: Math.round(worth) };
    // A day repeating yesterday's flow extends the last vertex instead of adding
    // one. Compared by flow, not geometry: the flows are exact where a slope
    // recomputed from rounded worths is not.
    const last = points[points.length - 1];
    if (last && last.day === i && nets[i] === lastNet) points[points.length - 1] = point;
    else points.push(point);
    lastNet = nets[i];
  }

  // A flat tail is still part of the line: without a closing vertex a projection
  // whose last bill falls in month three would simply stop there.
  if (bottomAt === null && (points.length === 0 || points[points.length - 1].day < days)) {
    points.push({ day: days, worth: Math.round(worth) });
  }

  // The net of the two halves, not the distance the balance travelled: the walk
  // stops at the floor, so measuring the drop would have a plan spending $200 a
  // day call itself $761 a month for running out in week four.
  const monthlyBurn = monthlyOut - monthlyIn;

  // Money already gone before the plan started has a runway of nothing. With no
  // crossing to find, the extrapolation below would divide a negative balance by
  // the burn and report negative months as if that were a length of time.
  if (depletionAt === null && currentWorth <= 0) {
    depletionAt = 0;
    depletionDay = isoDay(from);
  }

  let months: number | null;
  if (depletionAt !== null) {
    // The runway is the day your own money runs out — the zero crossing whether
    // or not a facility carries the line further down. Counting credit as runway
    // would report a healthier number for someone who had borrowed more.
    months = depletionAt / DAYS_PER_MONTH;
  } else if (monthlyBurn <= 0) {
    // The plan pays for itself — an unbounded runway.
    months = Infinity;
  } else {
    // Still solvent at the horizon: carry on at the average rate.
    months = days / DAYS_PER_MONTH + worth / monthlyBurn;
  }

  // The credit phase runs from wherever the money ran out to wherever the
  // borrowing did — from day zero when there was none to begin with.
  const creditMonths =
    bottomAt === null || floor >= NO_CREDIT_FLOOR
      ? null
      : (bottomAt - (depletionAt ?? 0)) / DAYS_PER_MONTH;

  return {
    points,
    depletionDay,
    creditExhaustedDay,
    months,
    creditMonths,
    monthlyBurn,
    monthlyOut,
    monthlyIn,
  };
}
