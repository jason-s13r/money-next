import "server-only";
import { connection } from "next/server";
import { db } from "./db";
import { isEssential, isKnownGroup, LIQUID_TYPES, LOCKED_TYPES } from "./categories";
import { fetchCutoff, periodKey, periodsThrough, type Period } from "./periods";

// Dashboard metrics. Deliberately limited to numbers that are honest *without*
// transaction flow classification (see docs/metrics.md, Part 0). Income, savings
// rate, and net cash flow are absent because they cannot be computed correctly
// until internal transfers are separated from real money movement: a naive
// income sum overstates the truth by roughly 2.3x.
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
  // Only classified spending. Before `flow` existed this had to read every
  // outflow and report how much had no category — but three quarters of that was
  // internal movement between accounts, not spending we failed to categorise.
  const rows = await db.transaction.findMany({
    where: { flow: "EXPENSE", date: { gte: cutoff } },
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
  inflow: number;
  outflow: number;
  /** Rows big enough to be worth an evening. Clearing these moves the numbers. */
  overThreshold: number;
};

/**
 * Money that was bucketed from the sign of the amount alone. It is counted, but
 * no rule established what it is — so an internal transfer hiding in here would
 * show up as income or spending.
 */
export async function getReviewQueue(threshold = 500): Promise<ReviewQueue> {
  await connection();
  const rows = await db.transaction.findMany({
    where: { flowSource: "default" },
    select: { amount: true },
  });

  return {
    rows: rows.length,
    inflow: rows.filter((r) => r.amount > 0).reduce((sum, r) => sum + r.amount, 0),
    outflow: rows.filter((r) => r.amount < 0).reduce((sum, r) => sum - r.amount, 0),
    overThreshold: rows.filter((r) => Math.abs(r.amount) > threshold).length,
  };
}

/**
 * Categorical palettes hold eight slots, and a ninth hue is indistinguishable
 * from an existing one under colour-blindness. The tail folds into "Other".
 */
const MAX_SPEND_SLOTS = 7;
const OTHER = "Other";
/** Counted, but no rule said what it was. Rendered in the de-emphasis grey. */
const UNCATEGORISED = "Uncategorised";
/** Money returned rather than earned. No refund row carries a spend category, so
 *  it cannot be netted off the category it came from; it stands as its own
 *  inflow instead. Net is identical either way. */
const REFUNDS = "Refunds";
/** A merchant the enrichment never named. Kept as a row so its money stays visible. */
const UNKNOWN_MERCHANT = "Unknown";

/**
 * One subcategory row, and the merchants beneath it.
 *
 * `total` is carried rather than summed from `merchants` because "Other"'s rows
 * are whole categories, which have a total but no merchants of their own.
 */
export type SpendDetail = {
  total: number;
  merchants: Map<string, number>;
};

export type PeriodBreakdown = {
  key: string;
  income: Map<string, number>;
  spend: Map<string, number>;
  /**
   * What each spending row is made of, keyed by the row above it. A real category
   * breaks down into its subcategories, and each of those into its merchants;
   * "Other" breaks down into the whole categories it swallowed, and stops there —
   * those rows lead to a group's own page instead. Either way the values sum to
   * the row above.
   */
  spendDetail: Map<string, Map<string, SpendDetail>>;
  incomeTotal: number;
  spendTotal: number;
  /**
   * The slice of the totals above that was bucketed from the sign of the amount
   * alone. An internal transfer hiding in here would be counted as real, so these
   * set the width of the net figure's uncertainty band.
   */
  defaultedIn: number;
  defaultedOut: number;
  /** Still in progress. Its totals are not comparable with a full period's. */
  partial: boolean;
};

/** Income − spending. Refunds sit inside income. */
export function netOf(p: PeriodBreakdown): number {
  return p.incomeTotal - p.spendTotal;
}

/**
 * If every defaulted inflow turned out to be an internal transfer, the net falls
 * by that much; if every defaulted outflow did, it rises. The truth is inside.
 */
export function netRange(p: PeriodBreakdown): [low: number, high: number] {
  const net = netOf(p);
  return [net - p.defaultedIn, net + p.defaultedOut];
}

export type Comparison = {
  period: Period;
  periods: PeriodBreakdown[];
  /** Stable slot order, computed over the whole window so a category keeps its
   *  colour from one period to the next. Colour follows the entity, not its rank
   *  within a single bar. */
  incomeCategories: string[];
  spendCategories: string[];
  /**
   * Disclosure rows for each spending category, ranked over the whole window so a
   * subcategory keeps its place from one period to the next. A category with one
   * subcategory is absent: the breakdown would only restate the row above it.
   */
  spendSubcategories: Map<string, string[]>;
  /** The same, one level down: category → subcategory → merchants, ranked. */
  spendMerchants: Map<string, Map<string, string[]>>;
  /** One axis shared by every bar in every period, so lengths are comparable
   *  both within a period and across them. */
  max: number;
  /** Transactions bucketed by sign alone, across the window. */
  defaultedRows: number;
  /**
   * How far the partial period's data actually reaches — the most recent
   * transaction, not today. A sync that ran an hour ago and a sync that ran last
   * week produce the same calendar month; only this tells them apart.
   * Null when the period in progress holds no transactions yet.
   */
  through: Date | null;
};

/**
 * Income and spending per period, split by category, for the comparison view.
 *
 * INTERNAL rows are excluded entirely — that is the whole point of classifying
 * them. UNCATEGORIZED rows are *not* excluded: they are surfaced as their own
 * segment, because dropping them silently would make income and spending look
 * complete when a fifth of the money is unaccounted for.
 */
export async function getComparison(period: Period, count: number): Promise<Comparison> {
  await connection();

  const now = new Date();
  const rows = await db.transaction.findMany({
    where: {
      date: { gte: fetchCutoff(now, period, count) },
      // INTERNAL is excluded — that is the entire point of classifying it.
      flow: { in: ["INCOME", "EXPENSE", "REFUND"] },
    },
    select: {
      date: true,
      amount: true,
      flow: true,
      flowSource: true,
      incomeCategory: true,
      categoryGroup: true,
      categoryName: true,
      merchantName: true,
    },
  });

  // Slot order is decided over *all* history, not the selected window. Ranking
  // within the window would repaint every category whenever the period changed —
  // a reader who learned "Food is blue" would be misled by switching to quarters.
  const [spendRanking, incomeRanking] = await Promise.all([
    db.transaction.groupBy({
      by: ["categoryGroup"],
      where: { flow: "EXPENSE", categoryGroup: { not: null } },
      _sum: { amount: true },
    }),
    db.transaction.groupBy({
      by: ["incomeCategory"],
      where: { flow: "INCOME", incomeCategory: { not: null } },
      _sum: { amount: true },
    }),
  ]);

  const byMagnitude = <T,>(rows: T[], value: (row: T) => number) =>
    [...rows].sort((a, b) => Math.abs(value(b)) - Math.abs(value(a)));

  const allSpendCategories = byMagnitude(spendRanking, (r) => r._sum.amount ?? 0).map(
    (r) => r.categoryGroup!,
  );
  const allIncomeCategories = byMagnitude(incomeRanking, (r) => r._sum.amount ?? 0).map(
    (r) => r.incomeCategory!,
  );

  // Ends with the period in progress. It is flagged `partial` rather than hidden:
  // the current month is the one the reader most wants to see, and the one most
  // easily misread beside its complete neighbours.
  const keys = periodsThrough(now, period, count);
  const currentKey = periodKey(now, period);
  const window = new Set(keys);

  const blank = (key: string): PeriodBreakdown => ({
    key,
    income: new Map(),
    spend: new Map(),
    spendDetail: new Map(),
    incomeTotal: 0,
    spendTotal: 0,
    defaultedIn: 0,
    defaultedOut: 0,
    partial: key === currentKey,
  });
  const periods = new Map(keys.map((key) => [key, blank(key)]));

  // The newest transaction of *any* flow — an internal transfer still tells you
  // how current the data is. Null unless it lands in the period in progress.
  const newest = await db.transaction.aggregate({ _max: { date: true } });
  const latest = newest._max.date;
  const through = latest && periodKey(latest, period) === currentKey ? latest : null;

  let defaultedRows = 0;

  for (const row of rows) {
    const key = periodKey(row.date, period);
    const bucket = periods.get(key);
    if (!bucket) continue;

    const value = Math.abs(row.amount);
    const defaulted = row.flowSource === "default";
    if (defaulted) {
      defaultedRows++;
      if (row.amount > 0) bucket.defaultedIn += value;
      else bucket.defaultedOut += value;
    }

    if (row.flow === "REFUND" || row.flow === "INCOME") {
      // A payer no rule recognised is still a payer; it just has no category.
      const category = row.flow === "REFUND" ? REFUNDS : (row.incomeCategory ?? UNCATEGORISED);
      bucket.income.set(category, (bucket.income.get(category) ?? 0) + value);
      bucket.incomeTotal += value;
      continue;
    }

    // EXPENSE. A row matched by an enrichment rule always has a `categoryGroup`
    // (NZFCC assigns one to spending categories only); a row that fell through to
    // the sign default has none.
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

  const kept = allSpendCategories.slice(0, MAX_SPEND_SLOTS);
  const tail = new Set(allSpendCategories.slice(MAX_SPEND_SLOTS));

  if (tail.size > 0) {
    for (const bucket of periods.values()) {
      let other = 0;
      // "Other" is composed of whole categories, not of subcategories: expanding it
      // should name the categories it swallowed, which is the question it raises.
      // They carry no merchants — each links to its group page, which has them all.
      const otherDetail = new Map<string, SpendDetail>();
      for (const category of tail) {
        const amount = bucket.spend.get(category) ?? 0;
        if (amount > 0) otherDetail.set(category, { total: amount, merchants: new Map() });
        other += amount;
        bucket.spend.delete(category);
        bucket.spendDetail.delete(category);
      }
      if (other > 0) {
        bucket.spend.set(OTHER, other);
        bucket.spendDetail.set(OTHER, otherDetail);
      }
    }
  }

  const ordered = [...periods.values()];
  const max = Math.max(1, ...ordered.map((p) => Math.max(p.incomeTotal, p.spendTotal)));

  // "Uncategorised" is appended rather than ranked: it is not an entity competing
  // for a colour slot, it is the absence of one, and it wears the grey.
  const present = (pick: (p: PeriodBreakdown) => Map<string, number>, category: string) =>
    ordered.some((p) => (pick(p).get(category) ?? 0) > 0);

  const spendBase = tail.size > 0 ? [...kept, OTHER] : kept;

  // Refunds are appended rather than ranked too: they sit outside the income
  // ranking query, and appending keeps every payer's colour where it was.
  const incomeBase = present((p) => p.income, REFUNDS)
    ? [...allIncomeCategories, REFUNDS]
    : allIncomeCategories;

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

  /** Descending by money, and dropped entirely when one child restates its parent. */
  const ranked = (totals: Map<string, number>) =>
    [...totals].sort((a, b) => b[1] - a[1]).map(([label]) => label);

  const spendSubcategories = new Map(
    [...subTotals]
      .filter(([, totals]) => totals.size > 1)
      .map(([category, totals]) => [category, ranked(totals)]),
  );

  const spendMerchants = new Map(
    [...merchantTotals].map(([category, byMerchant]) => [
      category,
      new Map(
        [...byMerchant]
          .filter(([, merchants]) => merchants.size > 1)
          .map(([label, merchants]) => [label, ranked(merchants)]),
      ),
    ]),
  );

  return {
    period,
    periods: ordered,
    incomeCategories: present((p) => p.income, UNCATEGORISED)
      ? [...incomeBase, UNCATEGORISED]
      : incomeBase,
    spendCategories: present((p) => p.spend, UNCATEGORISED) ? [...spendBase, UNCATEGORISED] : spendBase,
    spendSubcategories,
    spendMerchants,
    max,
    defaultedRows,
    through,
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
