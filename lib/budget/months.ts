// Month bucketing and recency weighting, in NZ local time.
//
// Factored out of `lib/server/metrics/spend/types.ts` — where these lived and which
// still re-exports them, so nothing that imported them there had to change — because
// budget inference now runs in the worker, and that module carries `server-only`
// and so cannot be imported outside a request. These are pure (an `Intl` formatter
// and arithmetic, no database), so both the request-side metrics and the worker-side
// inference share one copy rather than a drifting duplicate.

/** The forecast/inference window: the last twelve complete months. */
export const MONTHS = 12;

const NZ_TIMEZONE = "Pacific/Auckland";

const monthFormat = new Intl.DateTimeFormat("en-NZ", {
  timeZone: NZ_TIMEZONE,
  year: "numeric",
  month: "2-digit",
});

/** `2026-06`, in NZ local time. */
export function monthKey(date: Date): string {
  const parts = monthFormat.formatToParts(date);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  return `${year}-${month}`;
}

/**
 * The last `MONTHS` *complete* calendar months, oldest first. The current month is
 * excluded: a month that is three days old always looks like a spending collapse,
 * and it would drag every median down with it.
 */
export function completeMonths(now: Date): string[] {
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

/**
 * Mean of a monthly series (oldest first) biased toward recent months: month i,
 * counting from 1 at the oldest, carries weight i, so the newest month counts
 * MONTHS times as much as the oldest. Divides by the whole window's weight,
 * including months with no spend, so a category that is trailing off is faded out
 * rather than forecast at its former level.
 */
export function recencyWeightedMean(oldestFirst: number[]): number {
  let weighted = 0;
  let weight = 0;
  oldestFirst.forEach((value, i) => {
    weighted += (i + 1) * value;
    weight += i + 1;
  });
  return weight === 0 ? 0 : weighted / weight;
}
