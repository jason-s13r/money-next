// Historical FX reference rates from the European Central Bank, served by the
// Frankfurter project. Mirrored into the local `FxRate` table each sync (see
// scripts/ingest.ts) so cross-currency transfer matching resolves without a
// network hop, the same way the NZFCC catalog is mirrored (see lib/nzfcc.ts).
//
// No `import "server-only"`: scripts/ingest.ts imports this from plain Node.

// Frankfurter's stable v1 host. Rates are quoted against a base passed as `?base=`,
// so `rate` is units of the symbol currency per 1 unit of the base. The ECB
// publishes on business days only; a range request simply omits weekends and
// holidays.
const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";

/** The base currency rates are quoted against; it is always exactly 1. NZD is the
 *  currency this app mostly banks in, so the common NZD↔X pair is a single lookup
 *  (EUR base would still be correct — `amount * rateTo / rateFrom` is base-agnostic
 *  — but would need two lookups for every NZD conversion). */
export const FX_BASE_CURRENCY = "NZD";

/** One day's rate for one currency, flattened to the `FxRate` table's shape. */
export type FxRateRow = {
  date: Date;
  base: string;
  currency: string;
  rate: number;
};

/**
 * How far a reference rate may move from the last one we hold before we refuse
 * to believe it.
 *
 * A wrong rate is the quietest way to corrupt this app: it never errors, it just
 * silently restates every foreign balance and every converted metric. We take
 * these rates from a third party (frankfurter.dev, relaying the ECB), so an
 * upstream bug or compromise lands here unchallenged. Nothing else validates it.
 *
 * 20% in a day is far outside anything the ECB publishes for the currencies this
 * app holds — the 2015 CHF unpegging, about the most violent move in recent
 * major-currency history, was ~30%, and that is the kind of event worth a human
 * glance rather than a silent import. So this rejects data-quality accidents (a
 * misplaced decimal, an inverted quote, a zero) without vetoing real markets.
 */
export const FX_MAX_DAILY_MOVE = 0.2;

/** A rate we declined to store, kept so the sync can say what it ignored. */
export type FxAnomaly = {
  currency: string;
  date: Date;
  rate: number;
  /** The rate it was judged against; null when the rate is invalid on its face. */
  previous: number | null;
  reason: string;
};

/**
 * Screen fetched rates against the last rate known for each currency, dropping
 * any that jump more than {@link FX_MAX_DAILY_MOVE} or that are not a usable
 * number at all.
 *
 * Rejection deliberately *drops the row* rather than failing the sync: FX is
 * best-effort here, and yesterday's rate is a far better answer than no sync.
 * Each currency chains — an accepted rate becomes the baseline for the next day
 * — so a genuine multi-day trend passes while a single bad print is isolated.
 *
 * Pure, so it can be reasoned about without a database.
 */
export function screenFxRates(
  rows: FxRateRow[],
  lastKnown: Map<string, number>,
): { accepted: FxRateRow[]; rejected: FxAnomaly[] } {
  const accepted: FxRateRow[] = [];
  const rejected: FxAnomaly[] = [];
  const baseline = new Map(lastKnown);

  // Oldest first, so each currency's baseline advances a day at a time.
  const ordered = [...rows].toSorted((a, b) => a.date.getTime() - b.date.getTime());

  for (const row of ordered) {
    if (!Number.isFinite(row.rate) || row.rate <= 0) {
      rejected.push({
        currency: row.currency,
        date: row.date,
        rate: row.rate,
        previous: null,
        reason: "not a positive, finite rate",
      });
      continue;
    }

    const previous = baseline.get(row.currency);
    if (previous !== undefined && previous > 0) {
      const move = Math.abs(row.rate / previous - 1);
      if (move > FX_MAX_DAILY_MOVE) {
        rejected.push({
          currency: row.currency,
          date: row.date,
          rate: row.rate,
          previous,
          reason: `moved ${(move * 100).toFixed(1)}% from ${previous}`,
        });
        // Baseline stays put: the next day is judged against the last rate we
        // believed, not the one we just refused.
        continue;
      }
    }

    accepted.push(row);
    baseline.set(row.currency, row.rate);
  }

  return { accepted, rejected };
}

type TimeSeriesResponse = {
  base: string;
  start_date: string;
  end_date: string;
  rates: Record<string, Record<string, number>>;
};

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Daily rates for `symbols` (quoted against {@link FX_BASE_CURRENCY}) over
 * `[start, end]`, one row per currency per published day. The base is dropped from
 * the request — it is always 1 — and re-added as an explicit `rate: 1` row for
 * every day returned so the table can convert to and from the base uniformly.
 * Throws on a non-2xx response; the caller treats FX as best-effort (see
 * `syncFxRates`).
 */
export async function fetchFxRates(
  symbols: string[],
  start: Date,
  end: Date,
): Promise<FxRateRow[]> {
  const wanted = symbols.filter((c) => c && c !== FX_BASE_CURRENCY);
  if (wanted.length === 0 || start > end) return [];

  const url = `${FRANKFURTER_BASE_URL}/${toIsoDate(start)}..${toIsoDate(end)}?base=${FX_BASE_CURRENCY}&symbols=${wanted.join(",")}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Frankfurter FX fetch failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as TimeSeriesResponse;

  const needsBase = symbols.includes(FX_BASE_CURRENCY);
  const rows: FxRateRow[] = [];
  for (const [isoDate, byCurrency] of Object.entries(data.rates ?? {})) {
    const date = new Date(`${isoDate}T00:00:00.000Z`);
    if (needsBase) rows.push({ date, base: FX_BASE_CURRENCY, currency: FX_BASE_CURRENCY, rate: 1 });
    for (const [currency, rate] of Object.entries(byCurrency)) {
      rows.push({ date, base: FX_BASE_CURRENCY, currency, rate });
    }
  }
  return rows;
}
