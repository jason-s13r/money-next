import "server-only";
import { db } from "./db";
import { DEFAULT_CURRENCY } from "../format";
import { FX_BASE_CURRENCY } from "./fx";

// One home for turning the mixed-currency ledger into a single comparable figure.
// Accounts and transactions are held in AUD/CHF/EUR/USD as well as NZD, so a raw
// column of amounts — or a raw SQL sum of them — would be nonsense; everything the
// dashboard totals passes through the converter this module builds.
//
// Rates come from the mirrored ECB table (`FxRate`), quoted as units per 1 EUR
// (see lib/fx.ts). EUR is therefore always exactly 1 and never needs a lookup.

/** Display currency of last resort, when no active account reveals one — the app's
 *  one default (see {@link DEFAULT_CURRENCY}), also the fixed unit the listings total in. */
export const FALLBACK_DISPLAY_CURRENCY = DEFAULT_CURRENCY;

/**
 * The currency the dashboard totals in: whichever one the most active accounts are
 * held in, so the figures read in what the user mainly banks in rather than a
 * hard-coded NZD. Falls back to {@link FALLBACK_DISPLAY_CURRENCY} when no active
 * account carries a currency.
 */
export async function getDisplayCurrency(): Promise<string> {
  const grouped = await db.account.groupBy({
    by: ["currency"],
    where: { status: "ACTIVE", currency: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { currency: "desc" } },
  });
  return grouped[0]?.currency ?? FALLBACK_DISPLAY_CURRENCY;
}

/**
 * The nearest rate on or before `date` for each of `currencies`, keyed by
 * currency. ECB skips weekends and holidays, so a Saturday transaction reads
 * Friday's rate; passing today's date yields each currency's latest rate. EUR is
 * the base and always 1, added without a lookup; nulls and duplicates in the
 * input are ignored. Pass `date = null` for the latest rate regardless of date.
 */
export async function loadRates(
  currencies: (string | null)[],
  date: Date | null = null,
): Promise<Map<string, number>> {
  const wanted = [...new Set(currencies.filter((c): c is string => !!c && c !== FX_BASE_CURRENCY))];
  const map = new Map<string, number>([[FX_BASE_CURRENCY, 1]]);
  if (wanted.length === 0) return map;

  // Newest-first, so the first row seen for a currency is its nearest prior rate.
  const rows = await db.fxRate.findMany({
    where: { currency: { in: wanted }, ...(date ? { date: { lte: date } } : {}) },
    orderBy: { date: "desc" },
  });
  for (const row of rows) if (!map.has(row.currency)) map.set(row.currency, row.rate);
  return map;
}

/**
 * Convert `amount` from one currency to another through the EUR-based rates in
 * `rates`, or null when either side's rate is missing. The rates are units per 1
 * EUR, so crossing two of them cancels the base out: `amount * rateTo / rateFrom`.
 */
export function convert(
  amount: number,
  from: string | null,
  to: string | null,
  rates: Map<string, number>,
): number | null {
  if (!from || !to) return null;
  if (from === to) return amount;
  const rateFrom = rates.get(from);
  const rateTo = rates.get(to);
  if (rateFrom == null || rateTo == null) return null;
  return (amount * rateTo) / rateFrom;
}

/**
 * Expresses a dated foreign-currency amount in `display` at the rate in effect on
 * its own day — the rule every mixed-currency computation on the dashboard is
 * valued by, so a USD or CHF transaction counts for what it was actually worth
 * that day rather than being summed as if it were the display currency. A balance
 * has no transaction date, so callers pass today's date to value it at the latest
 * rate. When no rate covers a row — a currency the mirror never held, or a date
 * before the earliest rate — the amount is returned unchanged rather than dropped.
 */
export type DisplayConverter = (amount: number, currency: string | null, date: Date) => number;

/**
 * Builds a {@link DisplayConverter} to `display` for the currencies actually
 * present in a set of rows. The rate rows for those currencies (plus `display`,
 * the conversion target — EUR excepted, as it is the base and always 1) are loaded
 * once and indexed newest-first per currency, so each call is an in-memory
 * nearest-on-or-before lookup. An input already all in the display currency needs
 * no rates and issues no query.
 */
export async function displayConverter(
  display: string,
  currencies: (string | null)[],
): Promise<DisplayConverter> {
  // A conversion is needed only if some row is held in a currency other than the
  // display one. EUR counts here even though its rate is 1: it still converts *to*
  // the display currency.
  if (!currencies.some((c) => c && c !== display)) return (amount) => amount;

  const wanted = [
    ...new Set([...currencies, display].filter((c): c is string => !!c && c !== FX_BASE_CURRENCY)),
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
