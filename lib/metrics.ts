import "server-only";
import { connection } from "next/server";
import { db } from "./db";
import {
  INCOME_GROUP_NAMES,
  isEssential,
  isKnownGroup,
  LIQUID_TYPES,
  LOCKED_TYPES,
} from "./categories";
import { fetchCutoff, periodKey, periodWindow, type Period } from "./periods";

// Dashboard metrics. A transaction's nature is derived from two facts Akahu gives
// us at sync: the sign of `amount` (money in is income, money out is spending) and
// whether it carries a `categoryGroup` (categorised vs uncategorised spending).
// There is no classifier, so income and net cash flow will overstate the truth
// wherever an internal transfer is counted as real money — accepted until an
// in-app classification step exists (see docs/metrics.md, Part 0).
//
// Month bucketing happens in JavaScript against an explicit NZ timezone rather
// than in SQL. SQLite's `localtime` modifier reads the *server's* timezone, and
// 287 transactions fall in a different month under NZ time than under UTC —
// banks stamp most rows at midday UTC, which is evening in Auckland.

const NZ_TIMEZONE = "Pacific/Auckland";
const MONTHS = 12;
/** Overfetch window: comfortably more than 12 months, filtered precisely below. */
const FETCH_DAYS = 400;

const monthFormat = new Intl.DateTimeFormat("en-NZ", {
  timeZone: NZ_TIMEZONE,
  year: "numeric",
  month: "2-digit",
});

/** `2026-06`, in NZ local time. */
function monthKey(date: Date): string {
  const parts = monthFormat.formatToParts(date);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  return `${year}-${month}`;
}

/**
 * The last `MONTHS` *complete* calendar months, oldest first. The current month
 * is excluded: a month that is three days old always looks like a spending
 * collapse, and it would drag every median down with it.
 */
function completeMonths(now: Date): string[] {
  let [year, month] = monthKey(now).split("-").map(Number);
  const keys: string[] = [];
  for (let i = 0; i < MONTHS; i++) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    keys.unshift(`${year}-${String(month).padStart(2, "0")}`);
  }
  return keys;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export type BalanceSummary = {
  /** Spendable today: checking, savings, wallets. Uses available, not current. */
  liquid: number;
  /** KiwiSaver and investments — real, but not reachable for decades. */
  locked: number;
  /** Everything in NZD, including locked and any drawn debt. */
  totalNzd: number;
  /** Total minus locked. The number that reflects decisions you can make. */
  accessibleNzd: number;
  facility: {
    name: string;
    limit: number;
    /** Positive only when the facility is actually drawn down. */
    drawn: number;
    utilisation: number;
  } | null;
  /**
   * Non-NZD balances, listed and never summed into the totals above. There is no
   * exchange-rate table yet, and silently adding 1,001 AUD to 1,001 NZD would be
   * worse than showing nothing.
   */
  foreign: { currency: string; total: number }[];
};

export async function getBalanceSummary(): Promise<BalanceSummary> {
  await connection();
  const accounts = await db.account.findMany({ where: { status: "ACTIVE" } });

  const nzd = accounts.filter((a) => a.currency === "NZD");

  // Locked accounts report `balanceAvailable` as 0, so they must use `current`.
  const liquid = nzd
    .filter((a) => LIQUID_TYPES.has(a.type))
    .reduce((sum, a) => sum + (a.balanceAvailable ?? a.balanceCurrent ?? 0), 0);

  const locked = nzd
    .filter((a) => LOCKED_TYPES.has(a.type))
    .reduce((sum, a) => sum + (a.balanceCurrent ?? 0), 0);

  const totalNzd = nzd.reduce((sum, a) => sum + (a.balanceCurrent ?? 0), 0);

  // The revolving facility reports `balanceCurrent` signed: positive means in
  // credit, negative means drawn against the limit. Summing it into net worth is
  // therefore already correct, and only the negative case is debt.
  const revolving = nzd.find((a) => a.balanceLimit !== null && a.balanceLimit > 0);
  const facility = revolving
    ? {
        name: revolving.name,
        limit: revolving.balanceLimit!,
        drawn: Math.max(0, -(revolving.balanceCurrent ?? 0)),
        utilisation:
          Math.max(0, -(revolving.balanceCurrent ?? 0)) / revolving.balanceLimit!,
      }
    : null;

  const byCurrency = new Map<string, number>();
  for (const account of accounts) {
    if (!account.currency || account.currency === "NZD") continue;
    byCurrency.set(
      account.currency,
      (byCurrency.get(account.currency) ?? 0) + (account.balanceCurrent ?? 0),
    );
  }

  return {
    liquid,
    locked,
    totalNzd,
    accessibleNzd: totalNzd - locked,
    facility,
    foreign: [...byCurrency]
      .map(([currency, total]) => ({ currency, total }))
      .sort((a, b) => b.total - a.total),
  };
}

export type SpendSummary = {
  /** The 12 complete months the window covers, oldest first. */
  months: { key: string; categorised: number; essential: number }[];
  byCategory: { group: string; total: number }[];
  /** Typical month of non-discretionary spend. Null if there is no history. */
  medianEssential: number | null;
  /** Total classified spending over the window. */
  categorisedOut: number;
  /**
   * Group names Akahu returned that aren't in our NZFCC map. Always empty today.
   * If the standard gains a group, this surfaces it instead of letting it be
   * silently counted as discretionary and quietly inflate the runway.
   */
  unknownGroups: string[];
};

export async function getSpendSummary(): Promise<SpendSummary> {
  await connection();

  const cutoff = new Date(Date.now() - FETCH_DAYS * 24 * 60 * 60 * 1000);
  // Categorised spending: money out that Akahu tagged with a `categoryGroup`.
  // This drives the essential/median runway, so it deliberately ignores both
  // income and the uncategorised outflow that no group could name.
  const rows = await db.transaction.findMany({
    where: { amount: { lt: 0 }, categoryGroup: { not: null }, date: { gte: cutoff } },
    select: { date: true, amount: true, categoryGroup: true },
  });

  const keys = completeMonths(new Date());
  const window = new Set(keys);

  const categorisedByMonth = new Map(keys.map((k) => [k, 0]));
  const essentialByMonth = new Map(keys.map((k) => [k, 0]));
  const byCategory = new Map<string, number>();
  const unknownGroups = new Set<string>();
  let categorisedOut = 0;

  for (const row of rows) {
    const key = monthKey(row.date);
    if (!window.has(key)) continue;

    const spend = -row.amount;
    const group = row.categoryGroup;
    if (group === null) continue;

    if (!isKnownGroup(group)) unknownGroups.add(group);

    categorisedOut += spend;
    categorisedByMonth.set(key, categorisedByMonth.get(key)! + spend);
    byCategory.set(group, (byCategory.get(group) ?? 0) + spend);
    if (isEssential(group)) {
      essentialByMonth.set(key, essentialByMonth.get(key)! + spend);
    }
  }

  return {
    months: keys.map((key) => ({
      key,
      categorised: categorisedByMonth.get(key)!,
      essential: essentialByMonth.get(key)!,
    })),
    byCategory: [...byCategory]
      .map(([group, total]) => ({ group, total }))
      .sort((a, b) => b.total - a.total),
    medianEssential: median(keys.map((k) => essentialByMonth.get(k)!)),
    categorisedOut,
    unknownGroups: [...unknownGroups],
  };
}

export type ReviewQueue = {
  rows: number;
  outflow: number;
  /** Rows big enough to be worth an evening. Clearing these moves the numbers. */
  overThreshold: number;
};

/**
 * Spending with no `categoryId` — no specific NZFCC category, whether or not a
 * group was inferred. It is counted in the totals but belongs to no category, so
 * it is the queue a future classification step works through. Income is excluded:
 * its own uncategorised inflows are surfaced under the Income breakdown instead.
 */
export async function getReviewQueue(threshold = 500): Promise<ReviewQueue> {
  await connection();
  const rows = await db.transaction.findMany({
    where: { amount: { lt: 0 }, categoryId: null },
    select: { amount: true },
  });

  return {
    rows: rows.length,
    outflow: rows.reduce((sum, r) => sum - r.amount, 0),
    overThreshold: rows.filter((r) => Math.abs(r.amount) > threshold).length,
  };
}

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
      type: { notIn: ["TRANSFER"] },
    },
    select: {
      date: true,
      amount: true,
      categoryGroup: true,
      categoryName: true,
      merchantName: true,
    },
  });

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

    const value = Math.abs(row.amount);

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
    max,
    through,
    hasOlder,
  };
}

export { UNCATEGORISED, UNKNOWN_MERCHANT };

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
