// Month bucketing and recency weighting, in NZ local time. Pure (an `Intl`
// formatter and arithmetic, no database), shared by request-side metrics and
// worker-side budget inference.

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

/** The last `MONTHS` *complete* calendar months, oldest first. The current month
 *  is excluded — a month three days old always looks like a spending collapse. */
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

/** Mean of a monthly series (oldest first) biased toward recent months: month i,
 *  counting from 1 at the oldest, carries weight i, so the newest counts MONTHS
 *  times as much as the oldest. Divides by the whole window's weight, including
 *  months with no spend, so a category trailing off is faded out rather than
 *  forecast at its former level. */
export function recencyWeightedMean(oldestFirst: number[]): number {
  let weighted = 0;
  let weight = 0;
  oldestFirst.forEach((value, i) => {
    weighted += (i + 1) * value;
    weight += i + 1;
  });
  return weight === 0 ? 0 : weighted / weight;
}
