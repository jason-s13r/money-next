// Dates are stored as absolute instants (Timestamptz), so *displaying* one means
// choosing a timezone to resolve it into a calendar day. This used to lean on the
// server's default TZ, which was fine when the server was the owner's own machine
// — but under the self-host container that default is UTC, and an NZ-midnight
// transaction then renders as the previous day (in the tx header and the transfer
// candidate list alike). So pin the display zone here, the same Pacific/Auckland
// the period bucketing (lib/periods.ts) and spend metrics already fix on. A
// genuinely multi-region deployment would carry this per-workspace instead.
const DISPLAY_TIMEZONE = "Pacific/Auckland";

// The app's one default/display currency, the single literal every other module
// derives its NZD from: `format.ts` is safe for client and server alike (unlike
// the server-only `currency.ts`), so the constant lives here where anything can
// reach it. The dashboard may still *total* in a different currency when most
// accounts are held in one (see `getDisplayCurrency`); this is the fallback and
// the unit the transaction listings fix on.
export const DEFAULT_CURRENCY = "NZD";

export function formatMoney(amount: number | null, currency: string | null) {
  if (amount === null) return "—";
  return new Intl.NumberFormat("en-NZ", {
    style: "currency",
    currency: currency ?? DEFAULT_CURRENCY,
  }).format(amount);
}

/** Whole dollars, for stat tiles and axis ticks where cents are noise. */
export function formatMoneyWhole(amount: number, currency = DEFAULT_CURRENCY) {
  return new Intl.NumberFormat("en-NZ", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

// `en-US` rather than `en-NZ`: en-NZ abbreviates September as "Sept", which
// breaks the three-letter rhythm of an axis.
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const MONTH_ONLY = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

function monthDate(key: string) {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

/** `2025-07` → `Jul 2025`. */
export function formatMonthKey(key: string) {
  return MONTH_YEAR.format(monthDate(key));
}

/** `2025-07` → `Jul`. For axis ticks. */
export function formatMonthShort(key: string) {
  return MONTH_ONLY.format(monthDate(key));
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-NZ", {
    dateStyle: "medium",
    timeZone: DISPLAY_TIMEZONE,
  }).format(date);
}

export function formatDateTime(date: Date | null) {
  if (date === null) return "—";
  return new Intl.DateTimeFormat("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: DISPLAY_TIMEZONE,
  }).format(date);
}
