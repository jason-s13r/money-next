// Turning a plan's daily cash flows into a line, a depletion date and a rate.
//
// Pure, like its neighbours here: numbers in, numbers out, no database and no
// request context. That split is what lets the arithmetic be tested directly —
// `lib/server/metrics/budget/forecast.ts` is the half that reads the forecast
// budgets and expands them, and it has nothing to say about the shape of the
// answer that this file does not.

/** The average calendar month, for turning a daily walk into a monthly rate. */
export const DAYS_PER_MONTH = 365.25 / 12;

/**
 * How far forward a scenario is walked: two years.
 *
 * Long enough that an annual premium and a Christmas both show up (twice, so a
 * reader can see the rhythm), and short enough to stay honest — a budget written
 * today does not describe 2031, and drawing it out that far would dress a guess
 * as a projection.
 */
export const PROJECTION_DAYS = 730;

/**
 * The palette forecast budgets are coloured from, in order.
 *
 * Colour is derived from a budget's position in the forecast list at read time,
 * not stored on the row, so the palette is kept here as the single source of
 * truth for both the projection engine and the UI legend.
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

/**
 * A vertex of the projected balance line: `day` days after now, with `worth` at
 * the end of it.
 *
 * A vertex per *change*, not per day. Between two vertices nothing is planned to
 * move, so the balance is flat and one straight segment describes it exactly —
 * which keeps a two-year projection of a handful of monthly bills to a few dozen
 * points instead of 730, and keeps a flat rate to exactly one. `day` is
 * fractional only on the final vertex of a depleting line, where it is the
 * moment the balance crosses zero rather than the end of the day it did.
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
  /**
   * Months until that day. `Infinity` when the scenario never depletes (income
   * covers the plan); null only when there is nothing to project at all.
   * Extrapolated beyond the horizon at the average rate when the walk ends with
   * money left — a two-year window is where the *shape* stops being credible, not
   * where the arithmetic does.
   */
  months: number | null;
  /** Average monthly net outflow: positive burns the balance down. */
  monthlyBurn: number | null;
  /** The two halves of that net, both positive, for the tile and legend. */
  monthlyOut: number;
  monthlyIn: number;
  /**
   * Days in the horizon no budget in this scenario was active for, and which
   * therefore ran at the history-derived burn instead. Surfaced because a
   * scenario that is 95% fallback is barely a budget projection, and the reader
   * deserves to know that before trusting the date.
   */
  blendedDays: number;
};

const DAY_MS = 86_400_000;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The one set of forward bars the chart draws: each future day's planned net
 * flow, averaged across every forecast budget.
 *
 * Averaged rather than drawn per budget on purpose. The lines are already one
 * per scenario and colour tells them apart, but bars root at the same $0 line
 * and would overlap into a stack that reads as a total nobody planned. One grey
 * bar per day says the honest thing instead: this is the flow the plans expect
 * on that day, near enough.
 *
 * Days past a shorter scenario's horizon average only the scenarios that reach
 * them, so a two-year plan beside a six-month one is not quietly halved after
 * month six. Depletion is not a horizon: a scenario's flows are what it plans to
 * spend, and they keep counting even after its balance line has hit zero and
 * stopped being drawable.
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
 * Turn a scenario's daily net flows into the line, the depletion date and the
 * monthly rates.
 *
 * Split from the query and the expansion so both the real scenarios and the
 * synthesised no-scenario fallback go through one piece of arithmetic — the
 * fallback is a scenario whose every day is the flat rate, and the moment those
 * two diverge is the moment the "with no budgets you get exactly today's chart"
 * promise stops being checkable.
 */
export function walkProjection(
  nets: number[],
  outs: number[],
  ins: number[],
  currentWorth: number,
  from: Date,
): Pick<
  ProjectionScenario,
  "points" | "depletionDay" | "months" | "monthlyBurn" | "monthlyOut" | "monthlyIn"
> {
  const days = nets.length;
  const scale = days === 0 ? 0 : DAYS_PER_MONTH / days;
  const monthlyOut = outs.reduce((a, b) => a + b, 0) * scale;
  const monthlyIn = ins.reduce((a, b) => a + b, 0) * scale;

  const points: ProjectionPoint[] = [];
  let worth = currentWorth;
  let depletionDay: string | null = null;
  /** The previous day's flow, for the collinearity test below. */
  let lastNet = Number.NaN;

  for (let i = 0; i < days; i++) {
    if (nets[i] === 0) continue;
    const before = worth;
    worth += nets[i];

    if (worth <= 0 && before > 0) {
      // Land the line on zero rather than wherever the day's flow overshot to:
      // the crossing happens inside the day, and a line that dips below the axis
      // and stops there reads as a forecast of debt rather than of running out.
      const fraction = before / (before - worth);
      points.push({ day: i + fraction, worth: 0 });
      depletionDay = isoDay(new Date(from.getTime() + i * DAY_MS));
      break;
    }

    const point = { day: i + 1, worth: Math.round(worth) };
    // A day that repeats yesterday's flow continues yesterday's straight
    // segment, so it extends the last vertex instead of adding one. Compared by
    // flow rather than by geometry because the flows are exact where a slope
    // recomputed from rounded worths is not — and it is what makes a constant
    // daily rate come out as the single straight line the fallback promises.
    const last = points[points.length - 1];
    if (last && last.day === i && nets[i] === lastNet) points[points.length - 1] = point;
    else points.push(point);
    lastNet = nets[i];
  }

  // A flat tail is still part of the line: without a closing vertex a projection
  // whose last bill falls in month three would simply stop there.
  if (!depletionDay && (points.length === 0 || points[points.length - 1].day < days)) {
    points.push({ day: days, worth: Math.round(worth) });
  }

  // The net of the two halves, not the distance the balance actually travelled:
  // the walk stops the day it hits zero, so measuring the drop would report the
  // burn of however many days that took — a plan spending $200 a day would call
  // itself $761 a month for running out in week four. It would also make the
  // legend's own arithmetic (expenses less income is the net) fail to add up.
  const monthlyBurn = monthlyOut - monthlyIn;

  let months: number | null;
  if (depletionDay) {
    months = points[points.length - 1].day / DAYS_PER_MONTH;
  } else if (monthlyBurn <= 0) {
    // The plan pays for itself. Not "a very long runway" — an unbounded one.
    months = Infinity;
  } else {
    // Still solvent at the horizon: carry on at the average rate. The shape past
    // two years is a guess, but the rate is the same one the whole walk produced.
    months = days / DAYS_PER_MONTH + worth / monthlyBurn;
  }

  return { points, depletionDay, months, monthlyBurn, monthlyOut, monthlyIn };
}
