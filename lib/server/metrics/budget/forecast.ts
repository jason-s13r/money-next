import "server-only";

import { getDb } from "../../db/request";
import { displayConverter, getDisplayCurrency } from "../../currency";
import { money } from "../../money";
import { activeOn, occurrencesIn, type Frequency, type Lifespan } from "../../../budget/recurrence";
import {
  DAYS_PER_MONTH,
  PROJECTION_DAYS,
  SCENARIO_COLORS,
  walkProjection,
  type ProjectionScenario,
} from "../../../budget/projection";
import { nzDate } from "../../../periods";
import type { BalanceSummary } from "../balance";
import type { SpendSummary } from "../spend";

// The pure arithmetic lives in `lib/budget/projection.ts` — see its header. It is
// re-exported here so callers reach for the projection through the module that
// produces one, rather than having to know which half a name lives in.
export {
  DAYS_PER_MONTH,
  PROJECTION_DAYS,
  SCENARIO_COLORS,
  walkProjection,
  type ProjectionPoint,
  type ProjectionScenario,
} from "../../../budget/projection";

// Walking a plan forward: what the balance does if the budget holds.
//
// The dashboard's forward half used to be three scalars divided into a balance —
// a burn rate, a runway in months, a straight dashed line. A straight line is a
// statement that every month costs the same, which is false for anyone who has a
// Christmas, an annual insurance premium or a fortnightly wage, and it is exactly
// the thing a budget already knows better. So this walks day by day instead,
// summing the occurrences of every item in a forecast budget, and the line bends
// where the money actually moves.
//
// A forecast scenario is one *base* budget whose `forecast` flag is true, projected
// forward together with that base's date-active layers: a Christmas layer lands its
// extra spend only across the days its own window covers. Income is whatever the base
// contains: an emergency or worst-case line is a budget with the income items
// removed, not a toggle here — which is why there is no `includeIncome` any more.
//
// Nothing here writes, and nothing here invents a forecast. A workspace with none
// gets `[]`, and the dashboard simply draws no forward line until one is made.

const DAY_MS = 86_400_000;

/** UTC midnight of the NZ calendar day an instant falls in — the representation
 *  `occurrencesIn` returns, so occurrence dates index straight into the walk. */
function nzMidnight(date: Date): Date {
  const { year, month, day } = nzDate(date);
  return new Date(Date.UTC(year, month - 1, day));
}

/** The item columns a projection needs. */
type ItemRow = {
  amount: number;
  currency: string;
  frequency: string;
  interval: number;
  anchorDate: Date;
};

type BudgetRow = {
  name: string;
  lifespan: Lifespan;
  items: ItemRow[];
};

/**
 * Every forecast budget in the workspace, projected forward from today's accessible
 * balance.
 *
 * Empty when the workspace has no base budgets marked `forecast: true`. That is not
 * an error and must not be repaired here: a read that quietly created a forecast would
 * make the dashboard's first load a write, and would put a plan in front of someone
 * they never agreed to. The dashboard simply draws no forward line until one exists.
 */
export async function getForecastProjections(
  balances: BalanceSummary,
  spend: SpendSummary,
  now: Date = new Date(),
  days: number = PROJECTION_DAYS,
): Promise<ProjectionScenario[]> {
  const db = await getDb();

  // The same shape for the base and for each of its layers, so both expand through
  // one code path below.
  const budgetSelect = {
    id: true,
    name: true,
    startsOn: true,
    endsOn: true,
    repeatsAnnually: true,
    items: {
      select: {
        amount: true,
        currency: true,
        frequency: true,
        interval: true,
        anchorDate: true,
      },
    },
  } as const;

  const rows = await db.budget.findMany({
    where: { forecast: true, baseBudgetId: null },
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    select: {
      ...budgetSelect,
      layers: { select: budgetSelect },
    },
  });
  if (rows.length === 0) return [];

  const display = await getDisplayCurrency();
  const toDisplay = await displayConverter(
    display,
    rows.flatMap((s) => [
      ...s.items.map((i) => i.currency),
      ...s.layers.flatMap((l) => l.items.map((i) => i.currency)),
    ]),
  );

  // The walk starts tomorrow: today is already on the history side of the chart,
  // and its flows are in the ledger rather than in the plan.
  const from = new Date(nzMidnight(now).getTime() + DAY_MS);
  const dayAt = (i: number) => new Date(from.getTime() + i * DAY_MS);
  const to = dayAt(days);

  /** A budget row (base or layer) in the shape the walk consumes, taking the raw
   *  query rows whose amounts are still `Decimal`. */
  const toBudgetRow = (b: {
    name: string;
    startsOn: Date | null;
    endsOn: Date | null;
    repeatsAnnually: boolean;
    items: (Omit<ItemRow, "amount"> & {
      amount: import("../../../generated/prisma/client").Prisma.Decimal;
    })[];
  }): BudgetRow => ({
    name: b.name,
    lifespan: { startsOn: b.startsOn, endsOn: b.endsOn, repeatsAnnually: b.repeatsAnnually },
    items: b.items.map((item) => ({ ...item, amount: money(item.amount) })),
  });

  return rows.map((row, index) => {
    const base = toBudgetRow(row);
    const layers = row.layers.map(toBudgetRow);

    const nets = new Array<number>(days).fill(0);
    const outs = new Array<number>(days).fill(0);
    const ins = new Array<number>(days).fill(0);
    // Whether the *base* was live on that day. Coverage is the base's alone: it is
    // the ongoing plan, and the historic-burn blend below fills the days it does
    // not speak for. Layers are extras within their own windows, never the thing
    // that decides whether a day counts as planned.
    const covered = new Array<boolean>(days).fill(false);

    for (let i = 0; i < days; i++) {
      if (activeOn(base.lifespan, dayAt(i))) covered[i] = true;
    }

    // Expand a budget's items into the day arrays, each occurrence gated by that
    // budget's own lifespan. Returns whether it landed anything in the horizon, so
    // a layer that never fires in the next two years stays out of the legend.
    const expand = (budget: BudgetRow): boolean => {
      let contributed = false;
      for (const item of budget.items) {
        for (const date of occurrencesIn(
          {
            frequency: item.frequency as Frequency,
            interval: item.interval,
            anchorDate: item.anchorDate,
          },
          budget.lifespan,
          from,
          to,
        )) {
          const i = Math.round((date.getTime() - from.getTime()) / DAY_MS);
          if (i < 0 || i >= days) continue;
          const value = toDisplay(item.amount, item.currency, date);
          nets[i] += value;
          if (value > 0) ins[i] += value;
          else outs[i] += -value;
          contributed = true;
        }
      }
      return contributed;
    };

    // The base anchors the legend even if it happens to be empty; a layer earns its
    // place only by actually contributing within the horizon.
    const contributors = [base.name, ...layers.filter(expand).map((l) => l.name)];
    expand(base);

    // The blend rule. A forecast over only a Christmas budget covers three weeks of
    // the year; leaving the other forty-nine at zero would draw a perfectly flat
    // line and claim the reader spends nothing in February. On a day the budget
    // does not speak for, the history-derived burn does — the same figure the old
    // flat line ran at. Income is included on those days too, because a forecast's
    // stance on income is expressed in its budget, not withheld from the gaps.
    const fallbackOut = (spend.forecastBurn ?? 0) / DAYS_PER_MONTH;
    const fallbackIn = spend.forecastIncome / DAYS_PER_MONTH;
    let blendedDays = 0;
    for (let i = 0; i < days; i++) {
      if (covered[i]) continue;
      blendedDays++;
      nets[i] += fallbackIn - fallbackOut;
      outs[i] += fallbackOut;
      ins[i] += fallbackIn;
    }

    return {
      id: row.id,
      name: row.name,
      color: SCENARIO_COLORS[index % SCENARIO_COLORS.length],
      budgets: contributors,
      blendedDays,
      ...walkProjection(nets, outs, ins, balances.accessible, from),
    };
  });
}
