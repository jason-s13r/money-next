// Time bucketing for the comparison view. "Month" is only the default: the same
// machinery slices by week, quarter, or year.
//
// Every bucket is computed against an explicit NZ timezone rather than the
// server's. Banks stamp most transactions at midday UTC, which is evening in
// Auckland, so hundreds of rows land in a different bucket under UTC — enough to
// visibly move a monthly total.

export const PERIODS = ["week", "month", "quarter", "year"] as const;
export type Period = (typeof PERIODS)[number];

export function isPeriod(value: string): value is Period {
  return (PERIODS as readonly string[]).includes(value);
}

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

/** A sortable bucket key: `2026-W28`, `2026-07`, `2026-Q3`, `2026`. */
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
  }
}

/**
 * The last `count` *complete* periods, oldest first. The current period is
 * excluded: a month three days old always looks like a spending collapse, and
 * next to eleven full months it reads as a trend rather than an artefact.
 */
export function completePeriods(now: Date, period: Period, count: number): string[] {
  const keys: string[] = [];
  const ymd = nzDate(now);

  if (period === "week") {
    // Step back a week at a time from today's date, in UTC arithmetic — the NZ
    // calendar date is already resolved, so no offset math is needed.
    const cursor = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
    for (let i = 0; i <= count; i++) {
      cursor.setUTCDate(cursor.getUTCDate() - 7);
      const { isoYear, week } = isoWeek({
        year: cursor.getUTCFullYear(),
        month: cursor.getUTCMonth() + 1,
        day: cursor.getUTCDate(),
      });
      if (i < count) keys.unshift(`${isoYear}-W${pad(week)}`);
    }
    return keys;
  }

  if (period === "year") {
    for (let i = 1; i <= count; i++) keys.unshift(String(ymd.year - i));
    return keys;
  }

  const step = period === "quarter" ? 3 : 1;
  // Snap to the start of the current period, then walk backwards by `step`.
  let month = period === "quarter" ? Math.floor((ymd.month - 1) / 3) * 3 + 1 : ymd.month;
  let year = ymd.year;

  for (let i = 0; i < count; i++) {
    month -= step;
    while (month <= 0) {
      month += 12;
      year -= 1;
    }
    keys.unshift(
      period === "quarter"
        ? `${year}-Q${Math.ceil(month / 3)}`
        : `${year}-${pad(month)}`,
    );
  }
  return keys;
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
  return [...completePeriods(now, period, count - 1), periodKey(now, period)];
}

/** Generous lower bound for the fetch. Exact membership is decided by key. */
export function fetchCutoff(now: Date, period: Period, count: number): Date {
  const days = { week: 7, month: 31, quarter: 93, year: 366 }[period];
  return new Date(now.getTime() - (count + 2) * days * 86_400_000);
}

const MONTH_SHORT = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

/** `2026-07` → `Jul 2026`; `2026-Q3` → `Q3 2026`; `2026-W28` → `Week 28, 2026`. */
export function formatPeriodKey(key: string, period: Period): string {
  switch (period) {
    case "week": {
      const [year, week] = key.split("-W");
      return `Week ${Number(week)}, ${year}`;
    }
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
  }
}

/**
 * Compact form for a column header. Quarters carry a two-digit year because six
 * of them span more than one, and a header row reading `Q1 Q2 Q3 Q4 Q1 Q2` names
 * two different quarters the same thing. Twelve months or twelve weeks are each
 * unique within their window, so they don't need one.
 */
export function formatPeriodShort(key: string, period: Period): string {
  switch (period) {
    case "week":
      return `W${Number(key.split("-W")[1])}`;
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
  }
}
