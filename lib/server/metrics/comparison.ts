import "server-only";
import { connection } from "next/server";
import { db } from "../db";
import { INCOME_GROUP_NAMES } from "../../categories";
import { displayConverter, getDisplayCurrency } from "../currency";
import { fetchCutoff, periodKey, periodWindow, type Period } from "../../periods";

// Income and spending per period, for the comparison view. Buckets are keyed by
// NZ-local period (see lib/periods.ts), and every figure is valued in the display
// currency at the rate on its own day (see lib/currency.ts).

/** Counted, but Akahu named no category. Rendered in the de-emphasis grey. */
const UNCATEGORISED = "Uncategorised";
/** A merchant the enrichment never named. Kept as a row so its money stays visible. */
const UNKNOWN_MERCHANT = "Unknown";

/**
 * One subcategory row, and the merchants beneath it. `total` equals the sum of
 * `merchants`; it is stored rather than recomputed so the caller reads it once.
 */
export type SpendDetail = {
  total: number;
  merchants: Map<string, number>;
};

export type PeriodBreakdown = {
  key: string;
  spend: Map<string, number>;
  /**
   * What each spending row is made of, keyed by the row above it: a category
   * breaks down into its subcategories, and each of those into its merchants.
   * The values sum to the row above.
   */
  spendDetail: Map<string, Map<string, SpendDetail>>;
  /**
   * Income broken into its NZFCC subcategories (Wages, Refunds…), and each of
   * those into the merchants beneath — the income source. Inflows nothing named
   * fall under "Uncategorised" so the totals sum to `incomeTotal`.
   */
  incomeDetail: Map<string, SpendDetail>;
  incomeTotal: number;
  spendTotal: number;
  /** Still in progress. Its totals are not comparable with a full period's. */
  partial: boolean;
};

/** Income − spending. Overstated wherever a transfer is counted as either. */
export function netOf(p: PeriodBreakdown): number {
  return p.incomeTotal - p.spendTotal;
}

export type Comparison = {
  period: Period;
  periods: PeriodBreakdown[];
  /** Stable slot order, computed over the whole window so a category keeps its
   *  colour from one period to the next. Colour follows the entity, not its rank
   *  within a single bar. */
  spendCategories: string[];
  /**
   * The income subcategories (Wages, Refunds…), ranked over the whole window so
   * each keeps its place — and its colour — from one period to the next. This is
   * the flat list that colours the bar and legend; the table groups these under
   * their income group (see `incomeGroups`/`incomeGroupOf`).
   */
  incomeSubcategories: string[];
  /** The income groups present ("Periodic Income", "Other Income"), in that fixed
   *  order — the collapsible parent rows the table groups subcategories under. */
  incomeGroups: string[];
  /** Which income group each subcategory belongs to, so the table can nest it.
   *  Null only for a subcategory whose rows carry no group at all. */
  incomeGroupOf: Map<string, string | null>;
  /** Merchants beneath each income subcategory, ranked. Empty until a source is
   *  named — an all-unnamed level would only restate the row above it. */
  incomeMerchants: Map<string, string[]>;
  /**
   * Disclosure rows for each spending category, ranked over the whole window so a
   * subcategory keeps its place from one period to the next.
   */
  spendSubcategories: Map<string, string[]>;
  /** The same, one level down: category → subcategory → merchants, ranked. */
  spendMerchants: Map<string, Map<string, string[]>>;
  /** A representative merchant id for each merchant name shown, so the chart's
   *  merchant rows link to the id-keyed merchant page. Absent for the unnamed
   *  bucket; where a name spans several ids, any one — the link opens that id. */
  merchantIds: Map<string, string>;
  /** The logo URL for each merchant name shown, taken from the transaction's own
   *  `logo` when present, otherwise looked up from the Merchant table. Absent for
   *  the unnamed bucket. */
  merchantLogos: Map<string, string>;
  /** One axis shared by every bar in every period, so lengths are comparable
   *  both within a period and across them. */
  max: number;
  /**
   * How far the partial period's data actually reaches — the most recent
   * transaction, not today. A sync that ran an hour ago and a sync that ran last
   * week produce the same calendar month; only this tells them apart.
   * Null when the period in progress holds no transactions yet.
   */
  through: Date | null;
  /** Whether income/spending data exists in a period older than this window —
   *  i.e. whether paging further back would show anything. */
  hasOlder: boolean;
};

/**
 * Income and spending per period, for the comparison view. Income is one bucket
 * (inflows carry no categories); spending is split by Akahu's `categoryGroup`,
 * with the ungrouped remainder surfaced as its own "Uncategorised" segment rather
 * than dropped — hiding it would make the totals look complete when they are not.
 */
export async function getComparison(
  period: Period,
  count: number,
  offset = 0,
  now: Date = new Date(),
): Promise<Comparison> {
  await connection();

  const rows = await db.transaction.findMany({
    where: {
      date: { gte: fetchCutoff(now, period, count + offset) },
      // Exclude transfers from income/spend/net: both Akahu's tagged type and the
      // groups a user linked by hand (every leg holds `transferGroupId`).
      type: { notIn: ["TRANSFER"] },
      transferGroupId: null,
    },
    select: {
      date: true,
      amount: true,
      categoryGroup: true,
      categoryName: true,
      merchantName: true,
      merchantId: true,
      logo: true,
      account: { select: { currency: true } },
    },
  });

  // Every income/spend figure below is in the display currency, valuing each
  // foreign row at the rate on its own day (see displayConverter). The category
  // *ranking* just below is deliberately left on raw amounts: it only fixes
  // colour-slot order across all history, where the handful of foreign rows can't
  // change a group's rank.
  const display = await getDisplayCurrency();
  const toDisplay = await displayConverter(display, rows.map((r) => r.account.currency));

  // Slot order is decided over *all* history, not the selected window. Ranking
  // within the window would repaint every category whenever the period changed —
  // a reader who learned "Food is blue" would be misled by switching to quarters.
  const spendRanking = await db.transaction.groupBy({
    by: ["categoryGroup"],
    where: { categoryGroup: { notIn: [...INCOME_GROUP_NAMES] } },
    _sum: { amount: true },
  });

  const byMagnitude = <T,>(rows: T[], value: (row: T) => number) =>
    [...rows].sort((a, b) => Math.abs(value(b)) - Math.abs(value(a)));

  const allSpendCategories = byMagnitude(spendRanking, (r) => r._sum.amount ?? 0).map(
    (r) => r.categoryGroup!,
  );

  // The window, oldest first. At `offset` 0 it ends with the period in progress,
  // flagged `partial` rather than hidden — the current month is the one the reader
  // most wants to see, and the one most easily misread beside full neighbours.
  // A larger offset pages further back, and holds no partial period.
  const keys = periodWindow(now, period, count, offset);
  const currentKey = periodKey(now, period);
  const window = new Set(keys);

  const blank = (key: string): PeriodBreakdown => ({
    key,
    spend: new Map(),
    spendDetail: new Map(),
    incomeDetail: new Map(),
    incomeTotal: 0,
    spendTotal: 0,
    partial: key === currentKey,
  });
  const periods = new Map(keys.map((key) => [key, blank(key)]));

  // Which income group each subcategory belongs to, learned from the rows: a
  // subcategory's group is the same on every row that carries it, so a first-write
  // wins. Read out below to nest the subcategories under their group in the table.
  const incomeGroupOf = new Map<string, string | null>();

  // Logo URL for each merchant name, collected as rows are processed. The final
  // map is merged with the Merchant table lookup before returning.
  const merchantLogos = new Map<string, string>();

  // The newest transaction, whatever its direction — it still tells you how
  // current the data is. Null unless it lands in the period in progress.
  const newest = await db.transaction.aggregate({ _max: { date: true } });
  const latest = newest._max.date;
  const through = latest && periodKey(latest, period) === currentKey ? latest : null;

  // The oldest income/spending row decides whether paging further back is worth
  // offering. Period keys sort lexicographically within a period type, so an
  // earlier bucket is simply a key below the oldest one on screen.
  const oldest = await db.transaction.aggregate({
    where: { amount: { not: 0 } },
    _min: { date: true },
  });
  const earliest = oldest._min.date;
  const hasOlder = earliest !== null && periodKey(earliest, period) < keys[0];

  for (const row of rows) {
    const key = periodKey(row.date, period);
    const bucket = periods.get(key);
    if (!bucket) continue;

    const value = Math.abs(toDisplay(row.amount, row.account.currency, row.date));

    // Money in is income, shown on the shared axis but broken into its NZFCC
    // subcategories beneath, each nested under its income group and split into the
    // merchants that are its source. Inflows the user hasn't classified default to
    // "Other Income" (ingest) with an "Uncategorised" subcategory, so the rows still
    // sum to the income total. Enrichment names a merchant on almost no inflow
    // today, so the unnamed remainder collects under "Unknown" and the merchant
    // level stays hidden (ranked away below) until a source is actually linked.
    if (row.amount > 0) {
      bucket.incomeTotal += value;

      const label = row.categoryName ?? UNCATEGORISED;
      // First row to carry this subcategory fixes its group; every later row agrees.
      if (!incomeGroupOf.has(label)) incomeGroupOf.set(label, row.categoryGroup);
      const detail = bucket.incomeDetail.get(label) ?? { total: 0, merchants: new Map() };
      detail.total += value;
      const merchant = row.merchantName ?? UNKNOWN_MERCHANT;
      detail.merchants.set(merchant, (detail.merchants.get(merchant) ?? 0) + value);
      bucket.incomeDetail.set(label, detail);

      if (row.logo && merchant !== UNKNOWN_MERCHANT) {
        merchantLogos.set(merchant, row.logo);
      }
      continue;
    }

    // Money out is spending, split by Akahu's group when it named one.
    const category = row.categoryGroup ?? UNCATEGORISED;
    bucket.spend.set(category, (bucket.spend.get(category) ?? 0) + value);
    bucket.spendTotal += value;

    // NZFCC assigns group and name together, so a categorised row always has both
    // and an uncategorised one has neither — nothing to break "Uncategorised" into.
    if (row.categoryGroup && row.categoryName) {
      const byCategory = bucket.spendDetail.get(category) ?? new Map<string, SpendDetail>();
      const detail = byCategory.get(row.categoryName) ?? { total: 0, merchants: new Map() };

      detail.total += value;
      // Enrichment names a merchant on every categorised row today, but the column
      // is nullable, and money with no merchant still has to appear under its
      // category rather than vanish from the breakdown.
      const merchant = row.merchantName ?? UNKNOWN_MERCHANT;
      detail.merchants.set(merchant, (detail.merchants.get(merchant) ?? 0) + value);

      if (row.logo && merchant !== UNKNOWN_MERCHANT) {
        merchantLogos.set(merchant, row.logo);
      }

      byCategory.set(row.categoryName, detail);
      bucket.spendDetail.set(category, byCategory);
    }
  }

  const ordered = [...periods.values()];
  const max = Math.max(1, ...ordered.map((p) => Math.max(p.incomeTotal, p.spendTotal)));

  // "Uncategorised" is appended rather than ranked: it is not an entity competing
  // for a colour slot, it is the absence of one, and it wears the grey.
  const present = (pick: (p: PeriodBreakdown) => Map<string, number>, category: string) =>
    ordered.some((p) => (pick(p).get(category) ?? 0) > 0);

  // Every spending group, ranked. There is no "Other" tail: the palette runs out
  // at eight, so the ninth and tenth groups wear the overflow grey rather than
  // being folded away or falsely twinned with a major group's colour.
  const spendBase = allSpendCategories;

  // Ranked across the window, not within a period, for the same reason the colour
  // slots are: a row that jumped position every period would be unreadable.
  const subTotals = new Map<string, Map<string, number>>();
  const merchantTotals = new Map<string, Map<string, Map<string, number>>>();

  for (const p of ordered) {
    for (const [category, byCategory] of p.spendDetail) {
      const totals = subTotals.get(category) ?? new Map<string, number>();
      const byMerchant =
        merchantTotals.get(category) ?? new Map<string, Map<string, number>>();

      for (const [label, detail] of byCategory) {
        totals.set(label, (totals.get(label) ?? 0) + detail.total);

        const merchants = byMerchant.get(label) ?? new Map<string, number>();
        for (const [merchant, amount] of detail.merchants) {
          merchants.set(merchant, (merchants.get(merchant) ?? 0) + amount);
        }
        byMerchant.set(label, merchants);
      }

      subTotals.set(category, totals);
      merchantTotals.set(category, byMerchant);
    }
  }

  /** Descending by money. */
  const ranked = (totals: Map<string, number>) =>
    [...totals].sort((a, b) => b[1] - a[1]).map(([label]) => label);

  // A merchant level with no *named* merchant reveals nothing but the total it
  // sits under, so it is not offered — the "Unknown" remainder alone is a reveal
  // that restates the row above. Income names a merchant on almost no inflow
  // today, so this keeps its rows flat until a real source is linked.
  const rankedMerchants = (totals: Map<string, number>) =>
    [...totals.keys()].some((m) => m !== UNKNOWN_MERCHANT) ? ranked(totals) : [];

  // Every level keeps its rows even when there is only one — a lone subcategory
  // repeats its group's number, but it is the way down to the merchants beneath
  // it, and a lone merchant still adds a name and a link the row above lacks. The
  // reveal is always there when there is a level below to reveal.
  const spendSubcategories = new Map(
    [...subTotals].map(([category, totals]) => [category, ranked(totals)]),
  );

  // The income subcategories, ranked flat across both groups — this is the order
  // that colours the bar and legend. The table re-nests them under their group
  // (see incomeGroupOf); the ranking still governs order within each group. One
  // level down are the merchants beneath each subcategory.
  const incomeSubTotals = new Map<string, number>();
  const incomeMerchantTotals = new Map<string, Map<string, number>>();
  for (const p of ordered) {
    for (const [label, detail] of p.incomeDetail) {
      incomeSubTotals.set(label, (incomeSubTotals.get(label) ?? 0) + detail.total);

      const merchants = incomeMerchantTotals.get(label) ?? new Map<string, number>();
      for (const [merchant, amount] of detail.merchants) {
        merchants.set(merchant, (merchants.get(merchant) ?? 0) + amount);
      }
      incomeMerchantTotals.set(label, merchants);
    }
  }
  const incomeSubcategories = ranked(incomeSubTotals);
  const incomeMerchants = new Map(
    [...incomeMerchantTotals].map(([label, merchants]) => [label, rankedMerchants(merchants)]),
  );

  // The income groups actually present, in the fixed "Periodic Income" → "Other
  // Income" order the reader expects — not ranked, so the two parents never swap
  // places from one window to the next.
  const incomeGroups = INCOME_GROUP_NAMES.filter((group) =>
    [...incomeGroupOf.values()].includes(group),
  );

  const spendMerchants = new Map(
    [...merchantTotals].map(([category, byMerchant]) => [
      category,
      new Map([...byMerchant].map(([label, merchants]) => [label, rankedMerchants(merchants)])),
    ]),
  );

  // A name→id map so the chart's name-grouped merchant rows can link to the
  // id-keyed merchant page. First id wins for a name held under several (rare).
  // Merge in any logos from the Merchant table that weren't already captured
  // from transaction rows.
  const merchantRows = await db.merchant.findMany({ select: { id: true, name: true, logo: true } });
  const merchantIds = new Map<string, string>();
  for (const m of merchantRows) {
    if (!merchantIds.has(m.name)) merchantIds.set(m.name, m.id);
    if (m.logo && !merchantLogos.has(m.name)) merchantLogos.set(m.name, m.logo);
  }

  return {
    period,
    periods: ordered,
    spendCategories: present((p) => p.spend, UNCATEGORISED) ? [...spendBase, UNCATEGORISED] : spendBase,
    incomeSubcategories,
    incomeGroups,
    incomeGroupOf,
    incomeMerchants,
    spendSubcategories,
    spendMerchants,
    merchantIds,
    merchantLogos,
    max,
    through,
    hasOlder,
  };
}

export { UNCATEGORISED, UNKNOWN_MERCHANT };
