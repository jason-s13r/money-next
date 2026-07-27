import { FX_BASE_CURRENCY } from "../fx";
import { DEFAULT_CURRENCY } from "../../format";
import type { ScopedDb } from "../db";

// Display-currency conversion for budget inference, worker-safe.
//
// The request-side converter (lib/server/currency.ts) reaches for the ambient
// request client and carries `server-only`, so it cannot run in the worker where
// inference now lives. This mirrors it against a passed-in scoped db: the same
// display-currency choice (whichever the busiest active accounts are in), the same
// base (NZD), the same nearest-rate-on-or-before-the-day rule, and the same
// "unknown rate → leave the amount unchanged" fallback — decoupled from the request.
//
// No `import "server-only"`: like scripts/drain.ts and its neighbours, this runs in
// plain Node inside the worker.

/** A converter to the workspace's display currency, plus the currency itself. */
export type DisplayFx = {
  currency: string;
  toDisplay: (amount: number, currency: string | null, date: Date) => number;
};

export async function displayFxFor(db: ScopedDb): Promise<DisplayFx> {
  // The display currency: whichever the most active accounts are held in, falling
  // back to the app default when none reveals one — the same rule getDisplayCurrency
  // uses.
  const grouped = await db.account.groupBy({
    by: ["currency"],
    where: { status: "ACTIVE", currency: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { currency: "desc" } },
  });
  const currency = grouped[0]?.currency ?? DEFAULT_CURRENCY;

  // Every base-quoted rate, newest first per currency, so a lookup is the first
  // entry on or before the row's day. The table is small (a handful of currencies,
  // one row per business day), so loading it whole is cheaper than the request path's
  // per-set filtering here.
  const rows = await db.fxRate.findMany({
    where: { base: FX_BASE_CURRENCY },
    orderBy: { date: "desc" },
    select: { date: true, currency: true, rate: true },
  });
  const series = new Map<string, { t: number; rate: number }[]>();
  for (const row of rows) {
    const entry = { t: row.date.getTime(), rate: row.rate };
    const list = series.get(row.currency);
    if (list) list.push(entry);
    else series.set(row.currency, [entry]);
  }

  const rateOn = (c: string, t: number): number | null => {
    if (c === FX_BASE_CURRENCY) return 1;
    const list = series.get(c);
    if (!list) return null;
    for (const entry of list) if (entry.t <= t) return entry.rate;
    return null;
  };

  const toDisplay = (amount: number, c: string | null, date: Date): number => {
    if (!c || c === currency) return amount;
    const t = date.getTime();
    const from = rateOn(c, t);
    const to = rateOn(currency, t);
    if (from == null || to == null) return amount;
    return (amount * to) / from;
  };

  return { currency, toDisplay };
}
