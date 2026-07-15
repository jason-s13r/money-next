import { db } from "../db";
import { fetchFxRates, FX_BASE_CURRENCY } from "../fx";
import { DAY_MS } from "./shared";

/** A few days of overlap so a rate revised after first publish is re-fetched. */
const FX_OVERLAP_DAYS = 5;

/**
 * Mirror ECB daily FX rates for every foreign currency we hold, so cross-currency
 * transfer matching (see `getTransferCandidates`) works offline. Best-effort like
 * `syncCategories`: a fetch failure warns and lets the run finish. Incremental —
 * it fetches from just before the newest rate already stored (or the oldest
 * transaction on a first run) up to today, and upserts, so re-runs are cheap.
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

    await db.$transaction(
      rows.map((row) =>
        db.fxRate.upsert({
          where: {
            date_base_currency: { date: row.date, base: row.base, currency: row.currency },
          },
          create: row,
          update: { rate: row.rate },
        }),
      ),
    );

    console.log(`fx:           ${rows.length} rates synced (${currencies.join(", ")})`);
  } catch (error) {
    console.warn(`fx:           skipped — ${error instanceof Error ? error.message : String(error)}`);
  }
}
