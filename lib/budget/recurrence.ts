// Turning a budget item into dates, and deciding which days its budget applies on.
//
// This is the whole of the budget model's arithmetic, kept pure and free of the
// database so it can be tested without one. Everything above it — the breakdown,
// the projection — is bookkeeping on top of `occurrencesIn`.
//
// Two conventions, deliberately different, because they answer different
// questions:
//
//   * A **range** passed to `occurrencesIn` is half-open, `[from, to)`. Ranges
//     abut (one period's `to` is the next one's `from`), and half-open is the
//     only convention under which abutting ranges neither drop nor double-count
//     the boundary.
//   * A **lifespan** (`startsOn`/`endsOn`) is inclusive at both ends. It is not a
//     range between things, it is a span someone typed, and "active until 25
//     December" means the 25th is in.
//
// Dates are NZ calendar days throughout, for the reason lib/periods.ts sets out
// at length: banks stamp rows at midday UTC, which is evening in Auckland, so a
// day resolved in UTC is the wrong day often enough to move a monthly total. An
// occurrence is returned as UTC midnight of the NZ day it falls on — the same
// representation `periodStart` returns, and safe to hand to `periodKey`, because
// NZ leads UTC by 12–13 hours and so UTC midnight always resolves back to the
// same NZ calendar day.

import { nzDate, periodKey, type Period, type YMD } from "../periods";

/**
 * How often a budget item recurs.
 *
 * The recurring values are `lib/periods.ts`'s `PERIODS` minus `taxyear`, so a
 * budget speaks the vocabulary the breakdown buckets in. Two deliberate
 * differences from `Period`, and they are why this is its own list:
 *
 *   * **There is no `fortnight`.** A fortnight is `week` with `interval: 2`.
 *     Adding it as a frequency would make the same cadence expressible two ways,
 *     and then every comparison has to normalise. The editor offers it as a
 *     preset, which is where a convenience like that belongs.
 *   * **There is a `once`.** A one-off is not a period at all — it is the single
 *     occurrence an event budget is made of ("presents, on the 20th"). Without it
 *     a Christmas budget would have to fake its one-off items as yearly ones and
 *     rely on the window to hide the repeats.
 */
export const FREQUENCIES = ["once", "day", "week", "month", "quarter", "year"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export function isFrequency(value: string): value is Frequency {
  return (FREQUENCIES as readonly string[]).includes(value);
}

/** Singular button/label text for the frequency picker. */
export const FREQUENCY_LABELS: Record<Frequency, string> = {
  once: "Once",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
};

/** The recurrence half of a budget item — the columns, and nothing else. */
export type Recurrence = {
  frequency: Frequency;
  /** How many `frequency` steps between occurrences. Ignored for `once`. */
  interval: number;
  /** One real occurrence; the rest are derived from it. */
  anchorDate: Date;
};

/** The lifespan half of a budget — again, just the columns. */
export type Lifespan = {
  startsOn: Date | null;
  endsOn: Date | null;
  repeatsAnnually: boolean;
};

/** Always on: the general daily-living budget's window, and the default anywhere
 *  a caller has an item but no budget to hand. */
export const ALWAYS: Lifespan = { startsOn: null, endsOn: null, repeatsAnnually: false };

const DAY_MS = 86_400_000;

/** UTC midnight of an NZ calendar day — the representation every occurrence uses. */
function utcDay({ year, month, day }: YMD): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** Whole days from the epoch. Exact, because `utcDay` values are always midnight. */
function dayNumber(ymd: YMD): number {
  return utcDay(ymd).getTime() / DAY_MS;
}

function fromDayNumber(days: number): Date {
  return new Date(days * DAY_MS);
}

/** Months from year 0 — the month-based counterpart of `dayNumber`. */
function monthNumber({ year, month }: YMD): number {
  return year * 12 + (month - 1);
}

/** Days in a month, via the zeroth day of the next one. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `MMDD` as a comparable integer, for the annual-repeat window test. */
function monthDay({ month, day }: YMD): number {
  return month * 100 + day;
}

/**
 * How many months one step of `frequency` covers, or null if it isn't month-based.
 * Month, quarter and year differ only by this number: all three anchor on a
 * day-of-month and all three clamp the same way, so they share one code path.
 */
function monthsPerStep(frequency: Frequency): number | null {
  switch (frequency) {
    case "month":
      return 1;
    case "quarter":
      return 3;
    case "year":
      return 12;
    default:
      return null;
  }
}

/** Days per step for the two day-based frequencies, or null. */
function daysPerStep(frequency: Frequency): number | null {
  switch (frequency) {
    case "day":
      return 1;
    case "week":
      return 7;
    default:
      return null;
  }
}

/**
 * Whether a budget applies on a given day.
 *
 * An open-ended side is unbounded on that side; both open is the always-on
 * budget. `repeatsAnnually` reinterprets the window as a month-day span that
 * applies every year, and is meaningless (so ignored) unless both ends are set —
 * "from March onwards, every year" does not describe anything.
 *
 * The case worth reading twice is a repeating window that **wraps the New Year**
 * (15 Dec – 5 Jan). There the start is numerically *after* the end, so the
 * membership test flips from "between" to "outside the gap". Getting this wrong
 * fails silently — a Christmas budget that simply stops on 31 December — which is
 * why it is spelled out rather than left to a clever comparison.
 */
export function activeOn(lifespan: Lifespan, date: Date): boolean {
  const { startsOn, endsOn, repeatsAnnually } = lifespan;
  if (!startsOn && !endsOn) return true;

  const day = nzDate(date);

  if (repeatsAnnually && startsOn && endsOn) {
    const from = monthDay(nzDate(startsOn));
    const to = monthDay(nzDate(endsOn));
    const on = monthDay(day);
    return from <= to ? on >= from && on <= to : on >= from || on <= to;
  }

  const n = dayNumber(day);
  if (startsOn && n < dayNumber(nzDate(startsOn))) return false;
  if (endsOn && n > dayNumber(nzDate(endsOn))) return false;
  return true;
}

/**
 * The one instance of a bounded window that is running now, or the next one due.
 * Null for an open-ended lifespan, which has no instance to speak of.
 *
 * This is what "over its window" means to someone reading a Christmas budget: not
 * the abstract 1–25 December, but *this* December, with real dates and a real
 * length. For a repeating window it walks candidate years in order and takes the
 * first that has not finished — which handles the wrap across the New Year for
 * free, because a wrapping instance simply ends in the following year.
 *
 * Both ends are inclusive, like the lifespan itself.
 */
export function currentOrNextWindow(
  lifespan: Lifespan,
  now: Date,
): { from: Date; to: Date; days: number } | null {
  const { startsOn, endsOn, repeatsAnnually } = lifespan;
  if (!startsOn || !endsOn) return null;

  const start = nzDate(startsOn);
  const end = nzDate(endsOn);
  const today = dayNumber(nzDate(now));

  const span = (fromYear: number, toYear: number) => {
    const from = utcDay({ ...start, year: fromYear });
    // Clamped, so a window anchored on 29 February still resolves in a common year.
    const day = Math.min(end.day, daysInMonth(toYear, end.month));
    const to = utcDay({ year: toYear, month: end.month, day });
    return { from, to, days: dayNumber(nzDate(to)) - dayNumber(nzDate(from)) + 1 };
  };

  if (!repeatsAnnually) return span(start.year, end.year);

  // A window whose start falls after its end in the calendar wraps the New Year,
  // so its instance closes in the year after it opens.
  const wraps = monthDay(start) > monthDay(end);
  const thisYear = nzDate(now).year;

  for (let year = thisYear - 1; year <= thisYear + 1; year++) {
    const candidate = span(year, wraps ? year + 1 : year);
    if (dayNumber(nzDate(candidate.to)) >= today) return candidate;
  }

  return span(thisYear, wraps ? thisYear + 1 : thisYear);
}

/**
 * A cap on how many occurrences one item may produce for one range. Reached only
 * by a nonsense range (a daily item over a century), and it exists so a bad
 * `from`/`to` degrades into a truncated list rather than an unbounded loop that
 * takes the request down with it.
 */
const MAX_OCCURRENCES = 20_000;

/**
 * Every occurrence of `recurrence` in `[from, to)`, oldest first, clipped to the
 * days `lifespan` is active on.
 *
 * Month, quarter and year anchor on a **day of the month, clamped to the month's
 * length**: an item anchored on the 31st falls on 31 January, 28 February, 31
 * March. Clamping is computed from the original anchor day every time rather than
 * carried forward, so February does not permanently drag the item to the 28th —
 * that "clamp drift" is the classic bug in this shape of code, and it silently
 * moves a bill a few days earlier every year.
 *
 * Week and day step by whole days from the anchor, so `interval > 1` keeps its
 * phase: a fortnightly wage stays on its own fortnight rather than resetting at
 * each month or year boundary.
 */
export function occurrencesIn(
  recurrence: Recurrence,
  lifespan: Lifespan,
  from: Date,
  to: Date,
): Date[] {
  const { frequency, anchorDate } = recurrence;
  // A non-positive interval would step nowhere and loop forever. The write path
  // validates it, but this module is also handed rows written before that
  // validation existed (and rows edited in a psql session), so it defends itself.
  const interval = Math.max(1, Math.trunc(recurrence.interval));

  const anchor = nzDate(anchorDate);
  const fromDay = dayNumber(nzDate(from));
  const toDay = dayNumber(nzDate(to));
  if (toDay <= fromDay) return [];

  const keep = (date: Date, out: Date[]) => {
    if (activeOn(lifespan, date)) out.push(date);
  };

  const out: Date[] = [];

  if (frequency === "once") {
    const day = dayNumber(anchor);
    if (day >= fromDay && day < toDay) keep(utcDay(anchor), out);
    return out;
  }

  const perDay = daysPerStep(frequency);
  if (perDay !== null) {
    const step = perDay * interval;
    const anchorDay = dayNumber(anchor);
    // Jump straight to the first occurrence at or after `from` rather than
    // walking from the anchor, which may be years away.
    const steps = Math.ceil((fromDay - anchorDay) / step);
    for (let day = anchorDay + steps * step; day < toDay; day += step) {
      keep(fromDayNumber(day), out);
      if (out.length >= MAX_OCCURRENCES) break;
    }
    return out;
  }

  const perMonth = monthsPerStep(frequency)! * interval;
  const anchorMonth = monthNumber(anchor);
  const fromMonth = monthNumber(nzDate(from));
  // One step early: the occurrence in `from`'s own month may fall before `from`'s
  // day, and the one before that can still land inside the range once clamped.
  const steps = Math.floor((fromMonth - anchorMonth) / perMonth) - 1;

  for (let k = steps; ; k++) {
    const months = anchorMonth + k * perMonth;
    const year = Math.floor(months / 12);
    const month = (months % 12) + 1;
    // Recomputed from the anchor's own day every time — never from the previous
    // occurrence — so a short month clamps once instead of forever.
    const day = Math.min(anchor.day, daysInMonth(year, month));
    const n = dayNumber({ year, month, day });

    if (n >= toDay) break;
    if (n >= fromDay) keep(fromDayNumber(n), out);
    if (out.length >= MAX_OCCURRENCES) break;
  }

  return out;
}

/**
 * The item's total inside one period key — the function that makes a budget
 * comparable with history.
 *
 * It buckets with `periodKey`, the *same* function the historic breakdown buckets
 * transactions with, so a budget column and an actual column are guaranteed to
 * describe the identical span. It also means a fortnightly $500 wage reads $1,000
 * in most months and $1,500 in a three-payday month, which is what actually
 * happens — rather than a smoothed $1,083 that matches no month there has ever
 * been.
 */
export function amountInPeriod(
  recurrence: Recurrence,
  lifespan: Lifespan,
  amount: number,
  key: string,
  period: Period,
  from: Date,
  to: Date,
): number {
  let total = 0;
  for (const date of occurrencesIn(recurrence, lifespan, from, to)) {
    if (periodKey(date, period) === key) total += amount;
  }
  return total;
}

/** The first occurrence on or after `from`, or null within `withinDays`. */
export function nextOccurrence(
  recurrence: Recurrence,
  lifespan: Lifespan,
  from: Date,
  withinDays = 366 * 2,
): Date | null {
  const to = new Date(from.getTime() + withinDays * DAY_MS);
  return occurrencesIn(recurrence, lifespan, from, to)[0] ?? null;
}

const ORDINALS = ["th", "st", "nd", "rd"] as const;

/** `1` → `1st`, `22` → `22nd`, `13` → `13th`. */
export function ordinal(n: number): string {
  const rem = n % 100;
  const suffix = rem >= 11 && rem <= 13 ? "th" : (ORDINALS[n % 10] ?? "th");
  return `${n}${suffix}`;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The NZ weekday of an instant, Monday = 0 — the same numbering `isoWeek` uses. */
function nzWeekday(date: Date): number {
  return (utcDay(nzDate(date)).getUTCDay() + 6) % 7;
}

/**
 * The cadence in words: "Monthly, on the 1st", "Every 2 weeks on Thursday",
 * "Once, on 20 December". Lives here rather than in a component because it is a
 * statement about the recurrence rules above and should change when they do.
 */
export function describeRecurrence(recurrence: Recurrence): string {
  const { frequency, anchorDate } = recurrence;
  const interval = Math.max(1, Math.trunc(recurrence.interval));
  const anchor = nzDate(anchorDate);

  if (frequency === "once") {
    return `Once, on ${anchor.day} ${MONTHS[anchor.month - 1]} ${anchor.year}`;
  }

  // A fortnight is `week` × 2 in the data (see FREQUENCIES); it is still what a
  // person calls it, so it is named here rather than read out as "every 2 weeks".
  if (frequency === "week" && interval === 2) {
    return `Fortnightly, on ${WEEKDAYS[nzWeekday(anchorDate)]}`;
  }

  const every =
    interval === 1 ? FREQUENCY_LABELS[frequency] : `Every ${interval} ${frequency}s`;

  switch (frequency) {
    case "day":
      return every;
    case "week":
      return `${every} on ${WEEKDAYS[nzWeekday(anchorDate)]}`;
    case "month":
      return `${every}, on the ${ordinal(anchor.day)}`;
    case "quarter":
      return `${every}, on the ${ordinal(anchor.day)}`;
    case "year":
      return `${every}, on ${anchor.day} ${MONTHS[anchor.month - 1]}`;
  }
}

/** How a lifespan reads in a list: "Always on", "1–25 Dec, yearly", "12 Jan – 26 Jan 2027". */
export function describeLifespan(lifespan: Lifespan): string {
  const { startsOn, endsOn, repeatsAnnually } = lifespan;
  if (!startsOn && !endsOn) return "Always on";

  const short = (d: Date) => {
    const { day, month } = nzDate(d);
    return `${day} ${MONTHS[month - 1].slice(0, 3)}`;
  };
  const full = (d: Date) => `${short(d)} ${nzDate(d).year}`;

  if (repeatsAnnually && startsOn && endsOn) {
    return `${short(startsOn)} – ${short(endsOn)}, yearly`;
  }
  if (startsOn && endsOn) return `${full(startsOn)} – ${full(endsOn)}`;
  return startsOn ? `From ${full(startsOn)}` : `Until ${full(endsOn!)}`;
}
