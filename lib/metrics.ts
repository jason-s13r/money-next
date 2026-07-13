import "server-only";
import { connection } from "next/server";
import { db } from "./db";
import {
  FORECAST_EXCLUDED_CATEGORY_IDS,
  INCOME_GROUP_NAMES,
  isEssential,
  isKnownGroup,
  LIQUID_TYPES,
  LOCKED_TYPES,
  PERIODIC_INCOME_GROUP,
} from "./categories";
import { FX_BASE_CURRENCY } from "./fx";
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
/** A category joins the forecast only if it has spend in at least this many of
 *  the window's months — half of it. Monthly and near-monthly bills clear the
 *  bar; a one-off or annual lump recurs too rarely to, so it drops out of the
 *  forecast rather than inflating the estimated monthly burn. (Tax dribbles in
 *  most months yet is still lumpy, so it is excluded by id on top of this —
 *  see {@link FORECAST_EXCLUDED_CATEGORY_IDS}.) */
const RECUR_MIN_MONTHS = Math.ceil(MONTHS / 2);

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

/**
 * Mean of a monthly series (oldest first) biased toward recent months: month i,
 * counting from 1 at the oldest, carries weight i, so the newest month counts
 * MONTHS times as much as the oldest. Divides by the whole window's weight,
 * including months with no spend, so a category that is trailing off is faded
 * out rather than forecast at its former level.
 */
function recencyWeightedMean(oldestFirst: number[]): number {
  let weighted = 0;
  let weight = 0;
  oldestFirst.forEach((value, i) => {
    weighted += (i + 1) * value;
    weight += i + 1;
  });
  return weight === 0 ? 0 : weighted / weight;
}

/**
 * The forecast figure for a set of per-category monthly series: for every
 * category that recorded something in at least {@link RECUR_MIN_MONTHS} of the
 * window's months, its {@link recencyWeightedMean recency-weighted} average
 * monthly amount, summed. Irregular lumps recur too rarely to clear the bar and
 * are left out, so the total reads as "a normal month" rather than being jolted
 * by a one-off. The shape is shared by the spending burn and the periodic-income
 * forecast — the only difference is which rows fed the series.
 */
function forecastTotal(catMonths: Map<string, Map<string, number>>, keys: string[]): number {
  let total = 0;
  for (const series of catMonths.values()) {
    const monthly = keys.map((k) => series.get(k) ?? 0);
    if (monthly.filter((v) => v > 0).length < RECUR_MIN_MONTHS) continue;
    total += recencyWeightedMean(monthly);
  }
  return total;
}

/** Display currency of last resort, when there are no active accounts to learn it
 *  from. Matches `format.ts`'s default and the listings in `data.ts`. */
const FALLBACK_DISPLAY_CURRENCY = "NZD";

/**
 * The currency the dashboard totals in: whichever one the most active accounts are
 * held in, so the figures read in what the user mainly banks in rather than a
 * hard-coded NZD. Falls back to {@link FALLBACK_DISPLAY_CURRENCY} when no active
 * account carries a currency.
 */
async function getDisplayCurrency(): Promise<string> {
  const grouped = await db.account.groupBy({
    by: ["currency"],
    where: { status: "ACTIVE", currency: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { currency: "desc" } },
  });
  return grouped[0]?.currency ?? FALLBACK_DISPLAY_CURRENCY;
}

/**
 * Expresses a dated foreign-currency amount in the display currency at the ECB
 * rate in effect on its own day — the rule every mixed-currency computation on the
 * dashboard is valued by, so a USD or CHF transaction counts for what it was
 * actually worth that day rather than being summed as if it were the display
 * currency. Rates are mirrored per business day (see `FxRate`), so a weekend or
 * holiday date walks back to the most recent prior published day.
 */
type DisplayConverter = (amount: number, currency: string | null, date: Date) => number;

/**
 * Builds a {@link DisplayConverter} to `display` for the currencies actually
 * present in a set of rows. The rate rows for those currencies (plus `display`,
 * the conversion target — EUR excepted, as it is the ECB base and always 1) are
 * loaded once and indexed newest-first per currency, so each call is an in-memory
 * nearest-on-or-before lookup. An input already all in the display currency needs
 * no rates and issues no query. When no rate covers a row — a currency the mirror
 * never held, or a date before the earliest rate — the amount is returned
 * unchanged rather than dropped, the same best-effort fallback the transaction
 * listings use.
 */
async function loadDisplayConverter(
  display: string,
  currencies: (string | null)[],
): Promise<DisplayConverter> {
  // A conversion is needed only if some row is held in a currency other than the
  // display one. EUR counts here even though its rate is 1: it still converts *to*
  // the display currency.
  if (!currencies.some((c) => c && c !== display)) return (amount) => amount;

  // Load every distinct present currency plus the display target, EUR excepted —
  // it is the base, resolved to 1 without a lookup.
  const wanted = [
    ...new Set(
      [...currencies, display].filter((c): c is string => !!c && c !== FX_BASE_CURRENCY),
    ),
  ];
  const rows = await db.fxRate.findMany({
    where: { currency: { in: wanted } },
    orderBy: { date: "desc" },
    select: { date: true, currency: true, rate: true },
  });

  // Per currency, a newest-first list of [ms, rate]; the first entry on or before
  // a date is the rate in effect then.
  const series = new Map<string, { t: number; rate: number }[]>();
  for (const row of rows) {
    const entry = { t: row.date.getTime(), rate: row.rate };
    const list = series.get(row.currency);
    if (list) list.push(entry);
    else series.set(row.currency, [entry]);
  }

  const rateOn = (currency: string, t: number): number | null => {
    if (currency === FX_BASE_CURRENCY) return 1;
    const list = series.get(currency);
    if (!list) return null;
    for (const entry of list) if (entry.t <= t) return entry.rate;
    return null;
  };

  return (amount, currency, date) => {
    if (!currency || currency === display) return amount;
    const t = date.getTime();
    const from = rateOn(currency, t);
    const to = rateOn(display, t);
    if (from == null || to == null) return amount;
    return (amount * to) / from;
  };
}

export type BalanceSummary = {
  /** The currency every figure here is expressed in — the most common one across
   *  active accounts (see `getDisplayCurrency`). */
  displayCurrency: string;
  /** Spendable today: checking, savings, wallets. Uses available, not current. */
  liquid: number;
  /** KiwiSaver and investments — real, but not reachable for decades. */
  locked: number;
  /** Everything, including locked and any drawn debt, in the display currency. */
  total: number;
  /** Total minus locked. The number that reflects decisions you can make. */
  accessible: number;
  facility: {
    name: string;
    limit: number;
    /** Positive only when the facility is actually drawn down. */
    drawn: number;
    utilisation: number;
  } | null;
  /**
   * Every active balance summed per currency, each in its *own* currency — the
   * display currency included, so the breakdown accounts for the whole of net
   * worth rather than just its foreign part. The totals above fold each of these
   * in at its latest rate (see `getBalanceSummary`); this list explains them.
   */
  byCurrency: { currency: string; total: number }[];
};

export async function getBalanceSummary(): Promise<BalanceSummary> {
  await connection();
  const accounts = await db.account.findMany({ where: { status: "ACTIVE" } });

  // Every account is valued in the display currency. A balance has no transaction
  // date, so it converts at the currency's latest rate — the nearest on or before
  // now, which `loadDisplayConverter` resolves when handed today's date.
  const display = await getDisplayCurrency();
  const toDisplay = await loadDisplayConverter(display, accounts.map((a) => a.currency));
  const asOf = new Date();
  const inDisplay = (amount: number, currency: string | null) =>
    toDisplay(amount, currency, asOf);

  // Locked accounts report `balanceAvailable` as 0, so they must use `current`.
  const liquid = accounts
    .filter((a) => LIQUID_TYPES.has(a.type))
    .reduce((sum, a) => sum + inDisplay(a.balanceAvailable ?? a.balanceCurrent ?? 0, a.currency), 0);

  const locked = accounts
    .filter((a) => LOCKED_TYPES.has(a.type))
    .reduce((sum, a) => sum + inDisplay(a.balanceCurrent ?? 0, a.currency), 0);

  const total = accounts.reduce((sum, a) => sum + inDisplay(a.balanceCurrent ?? 0, a.currency), 0);

  // The revolving facility reports `balanceCurrent` signed: positive means in
  // credit, negative means drawn against the limit. Summing it into net worth is
  // therefore already correct, and only the negative case is debt. Its limit and
  // drawn amount are shown in the display currency; utilisation is a ratio within
  // one currency, so conversion leaves it unchanged.
  const revolving = accounts.find((a) => a.balanceLimit !== null && a.balanceLimit > 0);
  const drawnRaw = revolving ? Math.max(0, -(revolving.balanceCurrent ?? 0)) : 0;
  const facility = revolving
    ? {
        name: revolving.name,
        limit: inDisplay(revolving.balanceLimit!, revolving.currency),
        drawn: inDisplay(drawnRaw, revolving.currency),
        utilisation: drawnRaw / revolving.balanceLimit!,
      }
    : null;

  // Every currency held, including the display one, so the breakdown sums to net
  // worth rather than only its foreign remainder.
  const totalsByCurrency = new Map<string, number>();
  for (const account of accounts) {
    if (!account.currency) continue;
    totalsByCurrency.set(
      account.currency,
      (totalsByCurrency.get(account.currency) ?? 0) + (account.balanceCurrent ?? 0),
    );
  }

  return {
    displayCurrency: display,
    liquid,
    locked,
    total,
    accessible: total - locked,
    facility,
    byCurrency: [...totalsByCurrency]
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
  /**
   * Estimated monthly spend if life carries on unchanged: the recency-weighted
   * average of every category that recurs in at least half the window's months,
   * summed. Irregular lumps — an annual premium — recur too rarely to clear the
   * bar, and tax is struck out by id besides, so neither inflates it. Unlike
   * {@link medianEssential} this includes discretionary spend: it is the cost of
   * a normal month, not the essentials-only floor. Null with no spending history.
   */
  forecastBurn: number | null;
  /**
   * Estimated monthly income that can be leaned on to cover that burn: the same
   * recency-weighted, recurs-most-months forecast as {@link forecastBurn}, but
   * built from the "Periodic Income" group — wages, a benefit, ongoing support.
   * One-off receipts ("Other Income") are excluded, and an income stream that has
   * stopped fades out under the recency weighting rather than being counted at its
   * old level. Zero when no periodic income recurs; it never inflates the runway.
   */
  forecastIncome: number;
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
  // Categorised spending (money out Akahu tagged with a `categoryGroup`) plus
  // periodic income (money in filed under "Periodic Income"). The spending drives
  // the essential/median runway and the burn forecast; the periodic income is the
  // recurring receipt the forecast runway is allowed to net off against. Both the
  // uncategorised outflow no group could name and one-off "Other Income" are left
  // out — neither describes a normal month.
  const rows = await db.transaction.findMany({
    where: {
      date: { gte: cutoff },
      OR: [
        { amount: { lt: 0 }, categoryGroup: { not: null } },
        { amount: { gt: 0 }, categoryGroup: PERIODIC_INCOME_GROUP },
      ],
    },
    select: {
      date: true,
      amount: true,
      categoryGroup: true,
      categoryId: true,
      categoryName: true,
      account: { select: { currency: true } },
    },
  });

  // Foreign spend counts at the rate on the day it happened, not as if it were
  // already in the display currency.
  const display = await getDisplayCurrency();
  const toDisplay = await loadDisplayConverter(display, rows.map((r) => r.account.currency));

  const keys = completeMonths(new Date());
  const window = new Set(keys);

  const categorisedByMonth = new Map(keys.map((k) => [k, 0]));
  const essentialByMonth = new Map(keys.map((k) => [k, 0]));
  const byCategory = new Map<string, number>();
  // Per-category monthly series, keyed by the specific category where Akahu named
  // one and by the group otherwise. The finer the key, the cleaner the forecast:
  // a lumpy tax payment is isolated in its own category rather than smeared across
  // the recurring spend that shares its group.
  const catMonths = new Map<string, Map<string, number>>();
  // Periodic income's own per-category monthly series, forecast the same way as
  // the burn so the runway can net the two: a benefit or wage that keeps arriving
  // offsets the spend it is meant to cover.
  const incomeMonths = new Map<string, Map<string, number>>();
  const unknownGroups = new Set<string>();
  let categorisedOut = 0;

  for (const row of rows) {
    const key = monthKey(row.date);
    if (!window.has(key)) continue;

    const group = row.categoryGroup;
    if (group === null) continue;

    const amount = toDisplay(row.amount, row.account.currency, row.date);

    // Money in is periodic income (the query lets no other inflow through): feed
    // its own recurrence-tested series and take no further part in the spend side.
    if (row.amount > 0) {
      const catKey = row.categoryName ?? group;
      let series = incomeMonths.get(catKey);
      if (!series) incomeMonths.set(catKey, (series = new Map()));
      series.set(key, (series.get(key) ?? 0) + amount);
      continue;
    }

    const spend = -amount;

    if (!isKnownGroup(group)) unknownGroups.add(group);

    categorisedOut += spend;
    categorisedByMonth.set(key, categorisedByMonth.get(key)! + spend);
    byCategory.set(group, (byCategory.get(group) ?? 0) + spend);
    if (isEssential(group)) {
      essentialByMonth.set(key, essentialByMonth.get(key)! + spend);
    }

    // Tax and the like never enter the forecast, even though small charges keep
    // them looking recurring — their lumps would describe a month that never is.
    if (row.categoryId && FORECAST_EXCLUDED_CATEGORY_IDS.has(row.categoryId)) continue;
    const catKey = row.categoryName ?? group;
    let series = catMonths.get(catKey);
    if (!series) catMonths.set(catKey, (series = new Map()));
    series.set(key, (series.get(key) ?? 0) + spend);
  }

  // Forecast burn and the periodic income that offsets it, each the summed
  // recency-weighted average of the categories that recur in at least half the
  // months (see forecastTotal). Irregular lumps fail the recurrence test on both
  // sides, so each reads as "a normal month" rather than being jolted by a one-off.
  const forecastBurn = forecastTotal(catMonths, keys);
  const forecastIncome = forecastTotal(incomeMonths, keys);

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
    forecastBurn: catMonths.size === 0 ? null : forecastBurn,
    forecastIncome,
    categorisedOut,
    unknownGroups: [...unknownGroups],
  };
}

export type ReviewQueue = {
  rows: number;
  /** How many rows sit at or above {@link threshold} — the ones to do first. */
  overThreshold: number;
  /** The dollar cut-off that defines those rows, or `null` when there are none. */
  threshold: number | null;
};

/**
 * Spending with no `categoryId` — no specific NZFCC category, whether or not a
 * group was inferred. It is counted in the totals but belongs to no category, so
 * it is the queue a future classification step works through. Income is excluded:
 * its own uncategorised inflows are surfaced under the Income breakdown instead.
 *
 * Transfers are excluded on the same two tests used everywhere else — Akahu's
 * tagged `type` and the groups a user linked by hand (`transferGroupId`) — so
 * this count matches the uncategorised page it links to.
 *
 * The "do these first" cut-off is the 95th percentile of the queue's own amounts
 * rather than a fixed dollar figure: a fixed $500 line reads as "0 are over $500"
 * for anyone whose spending never reaches it, which is noise. A percentile always
 * points at the largest quarter of what is actually here.
 */
export async function getReviewQueue(percentile = 0.95): Promise<ReviewQueue> {
  await connection();
  const rows = await db.transaction.findMany({
    where: {
      categoryId: null,
      type: { notIn: ["TRANSFER"] },
      transferGroupId: null,
    },
    select: { amount: true },
  });

  if (rows.length === 0) {
    return { rows: 0, overThreshold: 0, threshold: null };
  }

  const amounts = rows.map((r) => Math.abs(r.amount)).sort((a, b) => a - b);
  // Nearest-rank: the smallest amount with at least `percentile` of the queue at
  // or below it. Clamped so the last index is never overrun.
  const rank = Math.min(amounts.length - 1, Math.ceil(percentile * amounts.length) - 1);
  const threshold = amounts[Math.max(0, rank)];

  return {
    rows: rows.length,
    overThreshold: amounts.filter((a) => a >= threshold).length,
    threshold,
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
  /** A representative merchant id for each merchant name shown, so the chart's
   *  merchant rows link to the id-keyed merchant page. Absent for the unnamed
   *  bucket; where a name spans several ids, any one — the link opens that id. */
  merchantIds: Map<string, string>;
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
      account: { select: { currency: true } },
    },
  });

  // Every income/spend figure below is in the display currency, valuing each
  // foreign row at the rate on its own day (see loadDisplayConverter). The category
  // *ranking* just below is deliberately left on raw amounts: it only fixes
  // colour-slot order across all history, where the handful of foreign rows can't
  // change a group's rank.
  const display = await getDisplayCurrency();
  const toDisplay = await loadDisplayConverter(display, rows.map((r) => r.account.currency));

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

  // A name→id map so the chart's name-grouped merchant rows can link to the
  // id-keyed merchant page. First id wins for a name held under several (rare).
  const merchantRows = await db.merchant.findMany({ select: { id: true, name: true } });
  const merchantIds = new Map<string, string>();
  for (const m of merchantRows) if (!merchantIds.has(m.name)) merchantIds.set(m.name, m.id);

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
