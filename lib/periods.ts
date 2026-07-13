// Time bucketing for the comparison view. "Month" is only the default: the same
// machinery slices by week, quarter, or year.
//
// Every bucket is computed against an explicit NZ timezone rather than the
// server's. Banks stamp most transactions at midday UTC, which is evening in
// Auckland, so hundreds of rows land in a different bucket under UTC — enough to
// visibly move a monthly total.

export const PERIODS = ["week", "month", "quarter", "year", "taxyear"] as const;
export type Period = (typeof PERIODS)[number];

export function isPeriod(value: string): value is Period {
  return (PERIODS as readonly string[]).includes(value);
}

/** Button text for the period selector. "taxyear" is the only key whose plain
 *  form ("Taxyear") reads wrong; the rest are just their capitalised selves. */
export const PERIOD_LABELS: Record<Period, string> = {
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

type YMD = { year: number; month: number; day: number };

function nzDate(date: Date): YMD {
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
 * The NZ tax year runs 1 April – 31 March, and is named by the calendar year it
 * *ends* in: the span 1 Apr 2026 – 31 Mar 2027 is "FY27". The key carries the full
 * ending year (`FY2027`) so it sorts lexicographically alongside the other kinds.
 */
function taxYearEnd({ year, month }: YMD): number {
  return month >= 4 ? year + 1 : year;
}

/** A sortable bucket key: `2026-W28`, `2026-07`, `2026-Q3`, `2026`, `FY2027`. */
export function periodKey(date: Date, period: Period): string {
  const ymd = nzDate(date);
  switch (period) {
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
      return `FY${taxYearEnd(ymd)}`;
  }
}

/**
 * The key of the period `i` steps before the one containing `now`. `i = 0` is
 * the current (possibly partial) period, `i = 1` the one before it, and so on.
 * Every window is a slice of this sequence.
 */
function periodBack(now: Date, period: Period, i: number): string {
  const ymd = nzDate(now);

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
  if (period === "taxyear") return `FY${taxYearEnd(ymd) - i}`;

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
export function periodWindow(now: Date, period: Period, count: number, offset = 0): string[] {
  const keys: string[] = [];
  for (let i = offset + count - 1; i >= offset; i--) keys.push(periodBack(now, period, i));
  return keys;
}

/**
 * The last `count` *complete* periods, oldest first. The current period is
 * excluded: a month three days old always looks like a spending collapse, and
 * next to eleven full months it reads as a trend rather than an artefact.
 */
export function completePeriods(now: Date, period: Period, count: number): string[] {
  return periodWindow(now, period, count, 1);
}

/**
 * The last `count` periods *ending with the one in progress*, oldest first.
 *
 * The current period is partial by definition, and a month three days old looks
 * like a spending collapse beside five full ones — so anything that averages or
 * takes a median over periods must use `completePeriods` instead. This is for
 * views that show each period on its own and can label the last one.
 */
export function periodsThrough(now: Date, period: Period, count: number): string[] {
  if (count < 1) return [];
  return periodWindow(now, period, count, 0);
}

/** Generous lower bound for the fetch. Exact membership is decided by key. */
export function fetchCutoff(now: Date, period: Period, count: number): Date {
  const days = { week: 7, month: 31, quarter: 93, year: 366, taxyear: 366 }[period];
  return new Date(now.getTime() - (count + 2) * days * 86_400_000);
}

/** The first calendar day of the period a key names, at UTC midnight. This is
 *  the date a window is anchored *from*, and what `?from=` in the url carries. */
export function periodStart(key: string, period: Period): Date {
  switch (period) {
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
      // `FY2027` opens on 1 April of the year before the one it's named for.
      const end = Number(key.slice(2));
      return new Date(Date.UTC(end - 1, 3, 1));
    }
  }
}

/**
 * The inverse of `periodStart`: the `offset` (see `periodWindow`) whose window
 * *begins* at the period holding `date`. The window's oldest key recedes as
 * offset grows, so this walks outward until it reaches or passes the target —
 * snapping a hand-edited or stale `?from=` to the nearest sane window. Bounded so
 * a far-future date can't loop forever.
 */
export function offsetForStartDate(now: Date, period: Period, count: number, date: Date): number {
  const target = periodKey(date, period);
  for (let offset = 0; offset < 6000; offset++) {
    if (periodBack(now, period, offset + count - 1) <= target) return offset;
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

/** The Monday that opens ISO week `2026-W28`, as a UTC date. */
function weekMonday(key: string): Date {
  const [isoYear, week] = key.split("-W").map(Number);
  // The Monday of ISO week 1 is found from Jan 4, which is always in week 1.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  return monday;
}

/** `2026-07` → `Jul 2026`; `2026-Q3` → `Q3 2026`; `2026-W28` → `Week of 6 Jul 2026`. */
export function formatPeriodKey(key: string, period: Period): string {
  switch (period) {
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
      // The span is the non-obvious part of a tax year, so the full label spells
      // it out: `FY27 (Apr 2026 – Mar 2027)`.
      const end = Number(key.slice(2));
      return `FY${key.slice(4)} (Apr ${end - 1} – Mar ${end})`;
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
  switch (period) {
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
