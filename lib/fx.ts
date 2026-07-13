// Historical FX reference rates from the European Central Bank, served by the
// Frankfurter project. Mirrored into the local `FxRate` table each sync (see
// scripts/ingest.ts) so cross-currency transfer matching resolves without a
// network hop, the same way the NZFCC catalog is mirrored (see lib/nzfcc.ts).
//
// No `import "server-only"`: scripts/ingest.ts imports this from plain Node.

// Frankfurter's stable v1 host. Rates are quoted against a base (EUR by default),
// so `rate` is units of the symbol currency per 1 EUR. The ECB publishes on
// business days only; a range request simply omits weekends and holidays.
const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";

/** The base currency ECB rates are quoted against; it is always exactly 1. */
export const FX_BASE_CURRENCY = "EUR";

/** One day's rate for one currency, flattened to the `FxRate` table's shape. */
export type FxRateRow = {
  date: Date;
  currency: string;
  rate: number;
};

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
 * Daily rates for `symbols` (quoted against EUR) over `[start, end]`, one row per
 * currency per published day. `EUR` is dropped from the request — it is the base,
 * always 1 — and re-added as an explicit `rate: 1` row for every day returned so
 * the table can convert to and from EUR uniformly. Throws on a non-2xx response;
 * the caller treats FX as best-effort (see `syncFxRates`).
 */
export async function fetchFxRates(
  symbols: string[],
  start: Date,
  end: Date,
): Promise<FxRateRow[]> {
  const wanted = symbols.filter((c) => c && c !== FX_BASE_CURRENCY);
  if (wanted.length === 0 || start > end) return [];

  const url = `${FRANKFURTER_BASE_URL}/${toIsoDate(start)}..${toIsoDate(end)}?symbols=${wanted.join(",")}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Frankfurter FX fetch failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as TimeSeriesResponse;

  const needsEur = symbols.includes(FX_BASE_CURRENCY);
  const rows: FxRateRow[] = [];
  for (const [isoDate, byCurrency] of Object.entries(data.rates ?? {})) {
    const date = new Date(`${isoDate}T00:00:00.000Z`);
    if (needsEur) rows.push({ date, currency: FX_BASE_CURRENCY, rate: 1 });
    for (const [currency, rate] of Object.entries(byCurrency)) {
      rows.push({ date, currency, rate });
    }
  }
  return rows;
}
