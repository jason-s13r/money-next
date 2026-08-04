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
 * The lowest balance a projection may be walked down to, when nobody says
 * otherwise: zero, the floor for someone whose money is all their own.
 *
 * A workspace with a revolving credit facility passes a negative floor instead —
 * see `BalanceSummary.creditFloor`. Spending past zero is what an overdraft *is*,
 * and a line that stopped at the axis would be drawing the day the balance goes
 * negative as if it were the day the money stops.
 */
export const NO_CREDIT_FLOOR = 0;

/**
 * A vertex of the projected balance line: `day` days after now, with `worth` at
 * the end of it.
 *
 * A vertex per *change*, not per day. Between two vertices nothing is planned to
 * move, so the balance is flat and one straight segment describes it exactly —
 * which keeps a two-year projection of a handful of monthly bills to a few dozen
 * points instead of 730, and keeps a flat rate to exactly one. `day` is
 * fractional only on the final vertex of a line that bottoms out, where it is the
 * moment the balance reaches its floor rather than the end of the day it did.
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
   * The NZ day the balance reaches the credit floor — every facility drawn to
   * its limit, and the day the line stops. Null when the plan never gets there,
   * and null always for a workspace with no facility, where there is no credit
   * to exhaust and `depletionDay` is already the end of the line.
   */
  creditExhaustedDay: string | null;
  /**
   * Months until that day. `Infinity` when the scenario never depletes (income
   * covers the plan); null only when there is nothing to project at all.
   * Extrapolated beyond the horizon at the average rate when the walk ends with
   * money left — a two-year window is where the *shape* stops being credible, not
   * where the arithmetic does.
   */
  months: number | null;
  /**
   * How many months the facility adds after that: the stretch between the
   * balance hitting zero and the credit hitting its limit.
   *
   * Deliberately a second figure rather than an addition to {@link months}. The
   * two are different kinds of time — one is how long the money lasts, the other
   * how long the borrowing lasts — and summing them would report a household
   * spending its overdraft as being in better shape than one without.
   *
   * Null when there is no facility, and null when the plan is still inside it at
   * the horizon: the day it would run out is past where the plan describes.
   */
  creditMonths: number | null;
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

/** A duration in the one form every runway figure is written in. Under a month
 *  is said in words: "0.4 months" is a decimal pretending to be a fact. */
export function formatMonths(months: number): string {
  if (months < 1) return "under a month";
  return `${months.toFixed(1)} months`;
}

/**
 * How long a scenario lasts, split into the two phases a reader has to keep
 * apart: the months spent from the balance, and then the months spent on credit.
 *
 * Shared by the runway tile's popover and the chart legend's, because they
 * describe the same scenario and the moment they format it differently is the
 * moment they look like two different answers. Both are shown *inside* a popover
 * on purpose — the figure on the face of the tile stays the balance's own months,
 * so the 6/3-month judgement is never made against borrowed time.
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
 *
 * `floor` is how far down the line may go — zero, or a negative credit floor for
 * someone with a card or an overdraft to draw on. It moves where the line *ends*
 * and nothing else: the runway is still measured to zero, because a facility
 * postpones running out of money by borrowing rather than by having any.
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

  // Where the line may not pass. Never above where the balance already is: a
  // facility reported as drawn past its own limit (a stale limit, a fee posted
  // over the top) would otherwise put the floor above the start and turn the
  // whole projection into a line drawn upward out of nothing.
  const bottom = Math.min(floor, currentWorth);

  const points: ProjectionPoint[] = [];
  let worth = currentWorth;
  let depletionDay: string | null = null;
  /** The fractional day of that crossing, for the runway. Kept apart from the
   *  line's last vertex, which with a facility carries on past it. */
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

    // Running out of your own money and running out of credit are two different
    // days, and only the second ends the line. Where there is no facility the
    // floor is zero and they are the same day, which is the chart as it was.
    //
    // The *first* crossing is the runway, which only needs saying now that the
    // walk carries on past it: a plan that goes under in March, is rescued by a
    // bonus in June and goes under again in July ran out in March.
    if (depletionAt === null && worth <= 0 && before > 0) {
      depletionDay = isoDay(new Date(from.getTime() + i * DAY_MS));
      depletionAt = i + before / (before - worth);
    }

    // `>=` on the left of the crossing, not `>`: mid-walk a day can only start
    // above the floor (a day that landed on it broke out here), so the equal case
    // is the one where there was no credit left to begin with — and that line
    // starts on the floor rather than sinking through it.
    if (worth <= bottom && before >= bottom) {
      // Land the line on the floor rather than wherever the day's flow overshot
      // to: the crossing happens inside the day, and a line that dips past its
      // limit and stops there forecasts borrowing nobody would be lent.
      const fraction = (before - bottom) / (before - worth);
      bottomAt = i + fraction;
      points.push({ day: bottomAt, worth: bottom });
      if (floor < NO_CREDIT_FLOOR) {
        creditExhaustedDay = isoDay(new Date(from.getTime() + i * DAY_MS));
      }
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
  if (bottomAt === null && (points.length === 0 || points[points.length - 1].day < days)) {
    points.push({ day: days, worth: Math.round(worth) });
  }

  // The net of the two halves, not the distance the balance actually travelled:
  // the walk stops the day it hits the floor, so measuring the drop would report
  // the burn of however many days that took — a plan spending $200 a day would
  // call itself $761 a month for running out in week four. It would also make the
  // legend's own arithmetic (expenses less income is the net) fail to add up.
  const monthlyBurn = monthlyOut - monthlyIn;

  // Money that was already gone before the plan started has a runway of nothing,
  // and saying so beats the arithmetic below: with no crossing to find, an
  // extrapolation would divide a negative balance by the burn and report a
  // negative number of months as if that were a length of time.
  if (depletionAt === null && currentWorth <= 0) {
    depletionAt = 0;
    depletionDay = isoDay(from);
  }

  let months: number | null;
  if (depletionAt !== null) {
    // The runway is the day your own money runs out, which is the zero crossing
    // whether or not a facility carries the line further down. Credit is what you
    // owe, not what you have, and counting it as runway would report a healthier
    // number for someone who had borrowed more.
    months = depletionAt / DAYS_PER_MONTH;
  } else if (monthlyBurn <= 0) {
    // The plan pays for itself. Not "a very long runway" — an unbounded one.
    months = Infinity;
  } else {
    // Still solvent at the horizon: carry on at the average rate. The shape past
    // two years is a guess, but the rate is the same one the whole walk produced.
    months = days / DAYS_PER_MONTH + worth / monthlyBurn;
  }

  // The credit phase runs from wherever the money ran out to wherever the
  // borrowing did — from day zero when there was none to begin with, since then
  // every day of the line was spent on credit.
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
