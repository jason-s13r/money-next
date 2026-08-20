// Time bucketing for the comparison view. "Month" is only the default: the same
// machinery slices by week, quarter, or year.
//
// Five of the six periods are decided by the calendar alone. The sixth, `taxyear`,
// is decided by the household — where its year starts is a workspace setting — so
// every function that can produce or read a tax-year key takes a `TaxYear`, and
// the overloads make that a compile error to forget rather than a quietly-NZ
// answer. Callers naming a fixed period (`"day"`, `"month"`) pass nothing.
//
// Every bucket is computed against an explicit NZ timezone rather than the
// server's. Banks stamp most transactions at midday UTC, which is evening in
// Auckland, so hundreds of rows land in a different bucket under UTC — enough to
// visibly move a monthly total.

export const PERIODS = ["day", "week", "month", "quarter", "year", "taxyear"] as const;
export type Period = (typeof PERIODS)[number];

/**
 * Every period whose span the calendar alone decides. The one that is left out is
 * `taxyear`, which depends on where the household put the start of its year — and
 * that distinction is load-bearing rather than decorative: the overloads below use
 * it so a caller naming `"day"` needs no configuration, while a caller holding a
 * `Period` variable cannot compile without one.
 */
export type FixedPeriod = Exclude<Period, "taxyear">;

export function isPeriod(value: string): value is Period {
  return (PERIODS as readonly string[]).includes(value);
}

/**
 * Where a household's tax year opens, as a month (1–12) and a day of it.
 *
 * The close is absent because it is not a separate fact: a tax year is a year, so
 * it ends the day before the next one opens. Storing both would let them disagree
 * and there would be no way to say which was meant.
 *
 * `startDay` is expected to be 1–28. Days beyond that fall out of the calendar in
 * some month or some year, and there is no non-arbitrary rule for where the year
 * then begins; the settings action refuses them rather than clamping silently.
 */
export type TaxYear = { startMonth: number; startDay: number };

/** NZ: 1 April – 31 March. What every workspace gets until it says otherwise, and
 *  what this module hard-coded before the start became a setting. */
export const DEFAULT_TAX_YEAR: TaxYear = { startMonth: 4, startDay: 1 };

/**
 * How many new years a tax year crosses: 1 for every start but 1 January, where
 * the span opens and closes inside the same calendar year.
 *
 * This is the whole of the naming rule. A tax year is named by the calendar year
 * it *ends* in, so the year it ends in is the year it started plus this — and,
 * read the other way, `FY2027` starts in `2027` minus this.
 */
function yearsSpanned(tax: TaxYear): number {
  return tax.startMonth === 1 && tax.startDay === 1 ? 0 : 1;
}

/** Button text for the period selector. "taxyear" is the only key whose plain
 *  form ("Taxyear") reads wrong; the rest are just their capitalised selves. */
export const PERIOD_LABELS: Record<Period, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
  taxyear: "Tax year",
};

const NZ_TIMEZONE = "Pacific/Auckland";

/** `en-CA` renders as `YYYY-MM-DD`, which is the only reason it's used here. */
const nzDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: NZ_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export type YMD = { year: number; month: number; day: number };

/** The NZ calendar day an instant falls on. Exported because budget recurrence
 *  (lib/budget/recurrence.ts) has to answer the same question this file does —
 *  "which local day is this?" — and two copies of the timezone resolution is
 *  exactly the drift the note at the top of this file warns about. */
export function nzDate(date: Date): YMD {
  const [year, month, day] = nzDateFormat.format(date).split("-").map(Number);
  return { year, month, day };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * ISO-8601 week: weeks start Monday, and week 1 is the one containing the first
 * Thursday of the year. The ISO year can differ from the calendar year in late
 * December and early January, which is exactly why this isn't `Math.ceil(day/7)`.
 */
function isoWeek({ year, month, day }: YMD): { isoYear: number; week: number } {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dayOfWeek + 3); // the week's Thursday

  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);

  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { isoYear, week };
}

/**
 * The tax year a date falls in, named by the calendar year it *ends* in: under
 * NZ's 1 April start the span 1 Apr 2026 – 31 Mar 2027 is "FY27". The key carries
 * the full ending year (`FY2027`) so it sorts lexicographically alongside the
 * other kinds.
 *
 * The comparison is on the (month, day) pair rather than the month alone, because
 * a start like the UK's 6 April splits its own month in two.
 */
function taxYearEnd({ year, month, day }: YMD, tax: TaxYear): number {
  const onOrAfterStart =
    month > tax.startMonth || (month === tax.startMonth && day >= tax.startDay);
  return (onOrAfterStart ? year : year - 1) + yearsSpanned(tax);
}

/** A sortable bucket key: `2026-07-14`, `2026-W28`, `2026-07`, `2026-Q3`, `2026`, `FY2027`. */
export function periodKey(date: Date, period: FixedPeriod): string;
export function periodKey(date: Date, period: Period, tax: TaxYear): string;
export function periodKey(date: Date, period: Period, tax: TaxYear = DEFAULT_TAX_YEAR): string {
  const ymd = nzDate(date);
  switch (period) {
    case "day":
      return `${ymd.year}-${pad(ymd.month)}-${pad(ymd.day)}`;
    case "week": {
      const { isoYear, week } = isoWeek(ymd);
      return `${isoYear}-W${pad(week)}`;
    }
    case "month":
      return `${ymd.year}-${pad(ymd.month)}`;
    case "quarter":
      return `${ymd.year}-Q${Math.ceil(ymd.month / 3)}`;
    case "year":
      return String(ymd.year);
    case "taxyear":
      return `FY${taxYearEnd(ymd, tax)}`;
  }
}

/**
 * The tax year a date falls in, as the calendar year it ends in — `2027` for a
 * date in NZ's FY27. The number `Transaction.taxYear` holds, so a page can offer
 * "the year this row's date implies" as one option beside the overrides.
 *
 * The same thing `periodKey(date, "taxyear", tax)` says, unwrapped from its key.
 */
export function taxYearOf(date: Date, tax: TaxYear): number {
  return taxYearEnd(nzDate(date), tax);
}

/**
 * How far either side of its own tax year a transaction may be reassigned.
 *
 * Back further than forward, because the case the override exists for is
 * asymmetric: a payment or refund settling a year that has already closed can
 * arrive years late (a late filing, an amended assessment), while paying forward
 * reaches one year at most — provisional tax for the year now starting. Bounds
 * rather than a free-text year so a typo cannot quietly park a transaction in
 * FY2062 where no view will ever show it again.
 */
export const TAX_YEAR_BACK = 5;
export const TAX_YEAR_FORWARD = 1;

/**
 * The tax years a transaction dated `date` may be assigned to, newest first, with
 * the year its own date falls in among them.
 *
 * One definition, read by both the picker and the action behind it — the picker so
 * it offers exactly what will be accepted, the action because it is a public POST
 * and the picker's option list is not a control.
 */
export function taxYearChoices(date: Date, tax: TaxYear): number[] {
  const own = taxYearOf(date, tax);
  const years: number[] = [];
  for (let y = own + TAX_YEAR_FORWARD; y >= own - TAX_YEAR_BACK; y--) years.push(y);
  return years;
}

/**
 * The bucket a *transaction* belongs in — its date's, unless someone has said the
 * row is relevant to a different tax year and the tax year is what we are slicing
 * by. See `Transaction.taxYear` in the schema for why that override exists.
 *
 * Only `taxyear` consults it, deliberately. A tax payment settling a closed year
 * still happened in the month it happened in, and moving it out of that month
 * would misreport the month to fix the year.
 *
 * This is the one place the two are reconciled, so a caller that buckets rows
 * calls this and never `periodKey` directly.
 */
export function transactionPeriodKey(
  row: { date: Date; taxYear: number | null },
  period: Period,
  tax: TaxYear,
): string {
  if (period === "taxyear" && row.taxYear !== null) return `FY${row.taxYear}`;
  return periodKey(row.date, period, tax);
}

/**
 * The key of the period `i` steps before the one containing `now`. `i = 0` is
 * the current (possibly partial) period, `i = 1` the one before it, and so on.
 * Every window is a slice of this sequence.
 */
function periodBack(now: Date, period: Period, i: number, tax: TaxYear): string {
  const ymd = nzDate(now);

  if (period === "day") {
    const cursor = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
    cursor.setUTCDate(cursor.getUTCDate() - i);
    return periodKey(cursor, period);
  }

  if (period === "week") {
    // Step back in whole weeks from today's date, in UTC arithmetic — the NZ
    // calendar date is already resolved, so no offset math is needed.
    const cursor = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
    cursor.setUTCDate(cursor.getUTCDate() - i * 7);
    const { isoYear, week } = isoWeek({
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
    });
    return `${isoYear}-W${pad(week)}`;
  }

  if (period === "year") return String(ymd.year - i);

  // Whole tax years step like calendar years, off the tax year `now` falls in.
  if (period === "taxyear") return `FY${taxYearEnd(ymd, tax) - i}`;

  const step = period === "quarter" ? 3 : 1;
  // Snap to the start of the current period, then walk back `i` steps.
  let month = (period === "quarter" ? Math.floor((ymd.month - 1) / 3) * 3 + 1 : ymd.month) - i * step;
  let year = ymd.year;
  while (month <= 0) {
    month += 12;
    year -= 1;
  }
  return period === "quarter" ? `${year}-Q${Math.ceil(month / 3)}` : `${year}-${pad(month)}`;
}

/**
 * A window of `count` period keys, oldest first, whose newest key sits `offset`
 * periods before the one in progress. `offset = 0` ends with the current period;
 * a larger offset pages further back in time.
 */
export function periodWindow(now: Date, period: FixedPeriod, count: number, offset?: number): string[];
export function periodWindow(
  now: Date,
  period: Period,
  count: number,
  offset: number,
  tax: TaxYear,
): string[];
export function periodWindow(
  now: Date,
  period: Period,
  count: number,
  offset = 0,
  tax: TaxYear = DEFAULT_TAX_YEAR,
): string[] {
  const keys: string[] = [];
  for (let i = offset + count - 1; i >= offset; i--) keys.push(periodBack(now, period, i, tax));
  return keys;
}

/** Generous lower bound for the fetch. Exact membership is decided by key. */
export function fetchCutoff(now: Date, period: Period, count: number): Date {
  const days = { day: 1, week: 7, month: 31, quarter: 93, year: 366, taxyear: 366 }[period];
  return new Date(now.getTime() - (count + 2) * days * 86_400_000);
}

/** The first calendar day of the period a key names, at UTC midnight. This is
 *  the date a window is anchored *from*, and what `?from=` in the url carries. */
export function periodStart(key: string, period: FixedPeriod): Date;
export function periodStart(key: string, period: Period, tax: TaxYear): Date;
export function periodStart(key: string, period: Period, tax: TaxYear = DEFAULT_TAX_YEAR): Date {
  switch (period) {
    case "day": {
      const [year, month, day] = key.split("-").map(Number);
      return new Date(Date.UTC(year, month - 1, day));
    }
    case "week":
      return weekMonday(key);
    case "month": {
      const [year, month] = key.split("-").map(Number);
      return new Date(Date.UTC(year, month - 1, 1));
    }
    case "quarter": {
      const [year, quarter] = key.split("-Q").map(Number);
      return new Date(Date.UTC(year, (quarter - 1) * 3, 1));
    }
    case "year":
      return new Date(Date.UTC(Number(key), 0, 1));
    case "taxyear": {
      // `FY2027` opens on the configured day of the year it is named for, less
      // the years it spans — under NZ's 1 April start, 1 Apr 2026.
      const end = Number(key.slice(2));
      return new Date(Date.UTC(end - yearsSpanned(tax), tax.startMonth - 1, tax.startDay));
    }
  }
}

/**
 * The first day *after* the period a key names — the exclusive end of its span,
 * which is the next period's `periodStart`.
 *
 * Found by stepping far enough past the start to be certainly inside the next
 * period and asking which one that is, rather than by adding a fixed length:
 * periods here are not all the same length (28–31 days, 90–92, 365–366), and the
 * one arithmetic that is always right is "the next key's start".
 */
export function periodEnd(key: string, period: FixedPeriod): Date;
export function periodEnd(key: string, period: Period, tax: TaxYear): Date;
export function periodEnd(key: string, period: Period, tax: TaxYear = DEFAULT_TAX_YEAR): Date {
  const start = periodStart(key, period, tax);
  // Comfortably longer than the period, comfortably shorter than two of them.
  const skip = { day: 1, week: 7, month: 32, quarter: 93, year: 366, taxyear: 366 }[period];
  const inside = new Date(start.getTime() + skip * 86_400_000);
  return periodStart(periodKey(inside, period, tax), period, tax);
}

/**
 * The inverse of `periodStart`: the `offset` (see `periodWindow`) whose window
 * *begins* at the period holding `date`. The window's oldest key recedes as
 * offset grows, so this walks outward until it reaches or passes the target —
 * snapping a hand-edited or stale `?from=` to the nearest sane window. Bounded so
 * a far-future date can't loop forever.
 */
export function offsetForStartDate(
  now: Date,
  period: FixedPeriod,
  count: number,
  date: Date,
): number;
export function offsetForStartDate(
  now: Date,
  period: Period,
  count: number,
  date: Date,
  tax: TaxYear,
): number;
export function offsetForStartDate(
  now: Date,
  period: Period,
  count: number,
  date: Date,
  tax: TaxYear = DEFAULT_TAX_YEAR,
): number {
  const target = periodKey(date, period, tax);
  for (let offset = 0; offset < 6000; offset++) {
    if (periodBack(now, period, offset + count - 1, tax) <= target) return offset;
  }
  return 0;
}

const MONTH_SHORT = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

// A week is named by the date of its Monday rather than "Week 28, 2026": an
// ordinal week number is precise but tells the reader nothing about *when*.
const WEEK_MONDAY = new Intl.DateTimeFormat("en-NZ", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const WEEK_MONDAY_SHORT = new Intl.DateTimeFormat("en-NZ", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const DAY_FULL = new Intl.DateTimeFormat("en-NZ", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_SHORT = new Intl.DateTimeFormat("en-NZ", {
  weekday: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** The Monday that opens ISO week `2026-W28`, as a UTC date. */
function weekMonday(key: string): Date {
  const [isoYear, week] = key.split("-W").map(Number);
  // The Monday of ISO week 1 is found from Jan 4, which is always in week 1.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  return monday;
}

/** `Jul 2026` — the month a tax year's first or last day sits in. */
const MONTH_YEAR = new Intl.DateTimeFormat("en-NZ", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** `2026-07-14` → `Mon 14 Jul 2026`; `2026-07` → `Jul 2026`; `2026-Q3` → `Q3 2026`; `2026-W28` → `Week of 6 Jul 2026`. */
export function formatPeriodKey(key: string, period: FixedPeriod): string;
export function formatPeriodKey(key: string, period: Period, tax: TaxYear): string;
export function formatPeriodKey(
  key: string,
  period: Period,
  tax: TaxYear = DEFAULT_TAX_YEAR,
): string {
  switch (period) {
    case "day":
      return DAY_FULL.format(periodStart(key, period));
    case "week":
      return `Week of ${WEEK_MONDAY.format(weekMonday(key))}`;
    case "month": {
      const [year, month] = key.split("-").map(Number);
      return `${MONTH_SHORT.format(new Date(Date.UTC(year, month - 1, 1)))} ${year}`;
    }
    case "quarter": {
      const [year, quarter] = key.split("-");
      return `${quarter} ${year}`;
    }
    case "year":
      return key;
    case "taxyear": {
      // The span is the non-obvious part of a tax year — doubly so now that it is
      // a setting — so the full label spells it out: `FY27 (Apr 2026 – Mar 2027)`.
      // The closing month comes from the day *before* the next year opens, which
      // is the only arithmetic that stays right for a 6 April or 1 January start.
      const first = periodStart(key, period, tax);
      const last = new Date(periodEnd(key, period, tax).getTime() - 86_400_000);
      return `FY${key.slice(4)} (${MONTH_YEAR.format(first)} – ${MONTH_YEAR.format(last)})`;
    }
  }
}

/**
 * Compact form for a column header. Quarters carry a two-digit year because six
 * of them span more than one, and a header row reading `Q1 Q2 Q3 Q4 Q1 Q2` names
 * two different quarters the same thing. Six months or six weeks are each unique
 * within their window, so they don't need one.
 */
export function formatPeriodShort(key: string, period: Period): string {
  // No `TaxYear` overload: `FY27` is the key's own last two digits, and where the
  // year starts changes nothing about how it is abbreviated.
  switch (period) {
    case "day":
      return DAY_SHORT.format(periodStart(key, period));
    case "week":
      return WEEK_MONDAY_SHORT.format(weekMonday(key));
    case "month": {
      const [year, month] = key.split("-").map(Number);
      return MONTH_SHORT.format(new Date(Date.UTC(year, month - 1, 1)));
    }
    case "quarter": {
      const [year, quarter] = key.split("-");
      return `${quarter} '${year.slice(2)}`;
    }
    case "year":
      return key;
    case "taxyear":
      return `FY${key.slice(4)}`;
  }
}
