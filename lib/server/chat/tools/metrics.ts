// No `import "server-only"`: like its neighbours in this directory, the registry it
// belongs to is loaded by the worker as well as by a chat turn.
import { PERIODS, formatPeriodKey, isPeriod, type Period } from "../../../periods";
import { buildComparison } from "../../metrics/comparison/build";
import type { Comparison, PeriodBreakdown } from "../../metrics/comparison/types";
import { asInt, asText, type Tool } from "./registry";

// The figures behind the "Income and spending" screen, as a tool.
//
// The point of reusing `buildComparison` rather than re-totalling the history the
// reading tools already hold is that **the model and the screen must agree**. Someone
// asking "what did I spend on Lifestyle in June?" usually has the answer in front of
// them, and a second number computed a slightly different way is worse than no number:
// they cannot tell which one is wrong, and neither can the model. Three things would
// have drifted immediately — the period buckets are keyed in NZ time and a transaction
// stamped midday UTC falls either side of a month boundary depending on which timezone
// decides (see lib/periods.ts); the screen counts ungrouped spending as "Uncategorised"
// where `loadHistory` drops it outright; and income is split by sign there and by
// category group here.
//
// So the numbers come from the same builder, and this file only reshapes them. What it
// drops is everything that exists for drawing: the shared axis, the slot order that
// keeps a category's colour stable, merchant ids and logos.
//
// It reaches further back than the reading tools, and cheaply, because it returns
// totals rather than rows: a year of `get_transactions` would be tens of thousands of
// lines, where a year of this is a dozen numbers.

/** More than a couple of years of any period is a wall of numbers, not an answer. */
const MAX_COUNT = 24;
const DEFAULT_COUNT = 6;
/** Per subcategory, when drilling into one area. Enough to name who the money went to;
 *  the long tail is what `get_transactions` is for. */
const MAX_MERCHANTS = 5;

export const getPeriodBreakdown: Tool = {
  name: "get_period_breakdown",
  description:
    "Income and spending totalled per period — the figures on the household's 'Income and spending' screen. " +
    "Use this for questions about trends, or about a month, quarter or year as a whole, rather than paging through transactions. " +
    "Without `area` it returns each period's income and spending totals, spending split by area and income split by category. " +
    "With `area` it breaks that one area down into its categories and the payees beneath them. " +
    "Both income and spending are reported as positive amounts here, unlike get_transactions where spending is negative.",
  parameters: {
    type: "object",
    properties: {
      period: {
        type: "string",
        enum: [...PERIODS],
        description: "How to bucket the totals. Default month.",
      },
      count: {
        type: "integer",
        description: `How many periods, ending with the one in progress. Default ${DEFAULT_COUNT}, maximum ${MAX_COUNT}.`,
      },
      offset: {
        type: "integer",
        description:
          "How many periods to step back before the window ends. 0, the default, ends with the period in progress; 1 ends with the one before it.",
      },
      area: {
        type: "string",
        description:
          "Optional. One spending area, exactly as this tool or list_spending_areas names it, to break down into its categories and payees.",
      },
    },
    required: [],
  },
  async handler(args, ctx) {
    const period = asText(args.period).toLowerCase() || "month";
    if (!isPeriod(period)) {
      return { error: `"${period}" is not a period.`, periods: [...PERIODS] };
    }

    const count = clamp(asInt(args.count) ?? DEFAULT_COUNT, 1, MAX_COUNT);
    const offset = Math.max(0, asInt(args.offset) ?? 0);
    const comparison = await buildComparison(ctx.db, period, count, offset, ctx.now);

    const wanted = asText(args.area);
    return wanted
      ? areaBreakdown(comparison, ctx.currency, wanted)
      : totalsBreakdown(comparison, ctx.currency);
  },
};

/** Everything both shapes say about the window itself. */
function envelope(comparison: Comparison, currency: string) {
  return {
    period: comparison.period,
    currency,
    // The most recent transaction in the period in progress, which is not today: a
    // month that is a third synced and a month that is a third elapsed look identical
    // from the totals alone, and only this tells them apart.
    through: comparison.through?.toISOString().slice(0, 10) ?? null,
    /** Whether anything exists before this window, so a model knows paging back is worth
     *  a second call rather than guessing that the history simply starts here. */
    hasOlder: comparison.hasOlder,
  };
}

/** What one period is called in the window, keyed and spelled out. `2026-07` is what
 *  to pass back; `Jul 2026` is what to say to a person. */
function named(p: PeriodBreakdown, period: Period) {
  return {
    period: p.key,
    label: formatPeriodKey(p.key, period),
    // The period in progress. Its totals are a fraction of a period and comparing them
    // with a whole one is the single easiest mistake to make with this data.
    ...(p.partial ? { partial: true } : {}),
  };
}

/** The whole window: totals per period, split by area and by income category. */
export function totalsBreakdown(comparison: Comparison, currency: string) {
  return {
    ...envelope(comparison, currency),
    periods: comparison.periods.map((p) => ({
      ...named(p, comparison.period),
      income: round2(p.incomeTotal),
      spend: round2(p.spendTotal),
      net: round2(p.incomeTotal - p.spendTotal),
      spendByArea: ranked(p.spend),
      incomeByCategory: ranked(new Map([...p.incomeDetail].map(([k, d]) => [k, d.total]))),
    })),
  };
}

/** One area, period by period, down to its categories and their payees. */
export function areaBreakdown(comparison: Comparison, currency: string, wanted: string) {
  const area = comparison.spendCategories.find(
    (name) => name.toLowerCase() === wanted.toLowerCase(),
  );
  if (!area) {
    return {
      error: `No spending area called "${wanted}".`,
      areas: comparison.spendCategories,
    };
  }

  return {
    ...envelope(comparison, currency),
    area,
    periods: comparison.periods.map((p) => {
      const total = p.spend.get(area) ?? 0;
      const detail = p.spendDetail.get(area) ?? new Map();
      const categories = [...detail]
        .sort((a, b) => b[1].total - a[1].total)
        .map(([category, spend]) => ({
          category,
          total: round2(spend.total),
          merchants: ranked(spend.merchants, MAX_MERCHANTS),
        }));

      // Spending filed under the area but under no category of it. The categories are
      // built only from rows that carry one, so without this the parts would silently
      // fail to sum to the whole and there would be nothing on the page saying why.
      const accounted = categories.reduce((sum, c) => sum + c.total, 0);
      const rest = round2(total - accounted);

      return {
        ...named(p, comparison.period),
        total: round2(total),
        categories,
        ...(rest > 0 ? { uncategorised: rest } : {}),
      };
    }),
  };
}

/** A totals map as a plain object, biggest first and zeroes dropped. Key order survives
 *  `JSON.stringify`, so the ranking reaches the model. */
function ranked(totals: Map<string, number>, limit?: number): Record<string, number> {
  const entries = [...totals]
    .filter(([, amount]) => round2(amount) !== 0)
    .sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(
    (limit ? entries.slice(0, limit) : entries).map(([label, amount]) => [label, round2(amount)]),
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
