import { db } from "../db";
import { fetchFxRates, FX_BASE_CURRENCY, screenFxRates } from "../fx";
import { DAY_MS } from "./shared";

/** A few days of overlap so a rate revised after first publish is re-fetched. */
const FX_OVERLAP_DAYS = 5;

/**
 * The most recent rate held for each currency — the baseline a freshly-fetched
 * rate is judged against.
 *
 * Read oldest-first and folded into a map so the last write per currency wins,
 * which is the newest. The table holds a few thousand narrow rows, so this is
 * cheaper than a per-currency "latest" query and needs no raw SQL.
 */
async function lastKnownRates(): Promise<Map<string, number>> {
  const rows = await db.fxRate.findMany({
    where: { base: FX_BASE_CURRENCY },
    orderBy: { date: "asc" },
    select: { currency: true, rate: true },
  });
  return new Map(rows.map((r) => [r.currency, r.rate]));
}

/**
 * Mirror ECB daily FX rates for every foreign currency we hold, so cross-currency
 * transfer matching (see `getTransferCandidates`) works offline. Best-effort like
 * `syncCategories`: a fetch failure warns and lets the run finish. Incremental —
 * it fetches from just before the newest rate already stored (or the oldest
 * transaction on a first run) up to today, and upserts, so re-runs are cheap.
 *
 * Fetched rates are screened before they land (see `screenFxRates`): this is
 * third-party data that nothing else validates, and a wrong rate doesn't error,
 * it just quietly restates every foreign balance on the dashboard.
 */
export async function syncFxRates(): Promise<void> {
  try {
    const accounts = await db.account.findMany({
      where: { currency: { not: null } },
      distinct: ["currency"],
      select: { currency: true },
    });
    const currencies = accounts.map((a) => a.currency!).filter(Boolean);
    // With one currency (or none) there is nothing to convert between.
    if (currencies.length < 2) {
      console.log("fx:           skipped — single currency");
      return;
    }

    const [latestRate, oldestTx] = await Promise.all([
      db.fxRate.aggregate({ where: { base: FX_BASE_CURRENCY }, _max: { date: true } }),
      db.transaction.aggregate({ _min: { date: true } }),
    ]);
    const from = latestRate._max.date
      ? new Date(latestRate._max.date.getTime() - FX_OVERLAP_DAYS * DAY_MS)
      : (oldestTx._min.date ?? new Date());
    const rows = await fetchFxRates(currencies, from, new Date());
    if (rows.length === 0) {
      console.log("fx:           up to date");
      return;
    }

    // A wrong rate silently restates every foreign balance and metric, and this
    // is third-party data nothing else checks. Screen it against what we already
    // believe before it lands (see `screenFxRates`).
    const lastKnown = await lastKnownRates();
    const { accepted, rejected } = screenFxRates(rows, lastKnown);

    for (const anomaly of rejected) {
      console.warn(
        `fx:           rejected ${anomaly.currency} @ ${anomaly.date.toISOString().slice(0, 10)} — ` +
          `${anomaly.reason}; keeping the previous rate`,
      );
    }

    if (accepted.length > 0) {
      await db.$transaction(
        accepted.map((row) =>
          db.fxRate.upsert({
            where: {
              date_base_currency: { date: row.date, base: row.base, currency: row.currency },
            },
            create: row,
            update: { rate: row.rate },
          }),
        ),
      );
    }

    const suffix = rejected.length > 0 ? `, ${rejected.length} rejected` : "";
    console.log(
      `fx:           ${accepted.length} rates synced (${currencies.join(", ")})${suffix}`,
    );
  } catch (error) {
    console.warn(`fx:           skipped — ${error instanceof Error ? error.message : String(error)}`);
  }
}
