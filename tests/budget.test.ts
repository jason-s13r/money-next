/**
 * The budget recurrence arithmetic.
 *
 *   pnpm test
 *
 * `lib/budget/recurrence.ts` is pure and has no database, which is the point:
 * every number a budget shows — a breakdown column, a projected balance, a
 * depletion date — is `occurrencesIn` counted up, so a bug here is wrong money
 * everywhere at once and wrong in a way that looks plausible.
 *
 * The cases below are the ones that fail *silently*: a bill that drifts a day
 * earlier each year, a fortnight that resets its phase at a month boundary, a
 * Christmas budget that stops on 31 December. None of them throws, and none is
 * visible without knowing what the right answer was.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ALWAYS,
  activeOn,
  currentOrNextWindow,
  describeLifespan,
  describeRecurrence,
  isFrequency,
  nextOccurrence,
  occurrencesIn,
  ordinal,
  type Lifespan,
  type Recurrence,
} from "../lib/budget/recurrence";
import {
  detectAmount,
  detectAnchor,
  detectRate,
  detectRecurrence,
  isCurrent,
} from "../lib/budget/detect";
import { averageDailyNets, walkProjection } from "../lib/budget/projection";
import { actualPerOccurrence, blendTowardActual, refinedAmount } from "../lib/budget/refine";

/** A UTC-midnight date, which is how occurrences come back. */
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
/** Occurrences as `YYYY-MM-DD`, which is what the assertions read in. */
const days = (dates: Date[]) => dates.map((x) => x.toISOString().slice(0, 10));

const every = (
  frequency: Recurrence["frequency"],
  anchor: string,
  interval = 1,
): Recurrence => ({ frequency, interval, anchorDate: d(anchor) });

describe("occurrencesIn steps at the right cadence", () => {
  test("a monthly bill lands on its anchor day each month", () => {
    const got = occurrencesIn(every("month", "2026-01-01"), ALWAYS, d("2026-01-01"), d("2026-05-01"));
    assert.deepEqual(days(got), ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
  });

  test("the range is half-open: `from` is in, `to` is out", () => {
    // Abutting ranges are how the projection walks period by period, so a
    // boundary counted twice would double a bill every month.
    const got = occurrencesIn(every("month", "2026-01-15"), ALWAYS, d("2026-01-15"), d("2026-02-15"));
    assert.deepEqual(days(got), ["2026-01-15"]);
  });

  test("a daily item respects its interval", () => {
    const got = occurrencesIn(every("day", "2026-03-01", 3), ALWAYS, d("2026-03-01"), d("2026-03-11"));
    assert.deepEqual(days(got), ["2026-03-01", "2026-03-04", "2026-03-07", "2026-03-10"]);
  });

  test("a quarterly item steps three months", () => {
    const got = occurrencesIn(every("quarter", "2026-02-10"), ALWAYS, d("2026-01-01"), d("2027-01-01"));
    assert.deepEqual(days(got), ["2026-02-10", "2026-05-10", "2026-08-10", "2026-11-10"]);
  });

  test("a yearly premium recurs on its date", () => {
    const got = occurrencesIn(every("year", "2024-07-09"), ALWAYS, d("2025-01-01"), d("2028-01-01"));
    assert.deepEqual(days(got), ["2025-07-09", "2026-07-09", "2027-07-09"]);
  });

  test("`once` yields exactly one occurrence, and only in its own range", () => {
    const item = every("once", "2026-12-20");
    assert.deepEqual(days(occurrencesIn(item, ALWAYS, d("2026-01-01"), d("2027-01-01"))), ["2026-12-20"]);
    assert.deepEqual(occurrencesIn(item, ALWAYS, d("2027-01-01"), d("2028-01-01")), []);
  });

  test("an empty or inverted range yields nothing rather than looping", () => {
    assert.deepEqual(occurrencesIn(every("day", "2026-01-01"), ALWAYS, d("2026-05-01"), d("2026-05-01")), []);
    assert.deepEqual(occurrencesIn(every("day", "2026-01-01"), ALWAYS, d("2026-05-01"), d("2026-04-01")), []);
  });

  test("a zero or negative interval is clamped rather than hanging", () => {
    // Not reachable through the write path, which validates. Reachable through a
    // row written before that validation existed, or edited in psql — and the
    // failure mode of *not* defending is an infinite loop in a request.
    const got = occurrencesIn(
      { frequency: "day", interval: 0, anchorDate: d("2026-01-01") },
      ALWAYS,
      d("2026-01-01"),
      d("2026-01-04"),
    );
    assert.deepEqual(days(got), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  });
});

describe("month-end clamping does not drift", () => {
  test("a bill anchored on the 31st clamps per month and returns to the 31st", () => {
    // The silent bug this exists for: clamping from the *previous* occurrence
    // instead of the anchor pins the item to the 28th for good after February,
    // moving a real bill three days early every year thereafter.
    const got = occurrencesIn(every("month", "2026-01-31"), ALWAYS, d("2026-01-01"), d("2026-06-01"));
    assert.deepEqual(days(got), [
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
  });

  test("29 February clamps in a common year and survives in a leap year", () => {
    const got = occurrencesIn(every("year", "2024-02-29"), ALWAYS, d("2025-01-01"), d("2029-01-01"));
    assert.deepEqual(days(got), ["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  });

  test("a 30th-anchored quarterly item clamps only in February", () => {
    // Anchored in November so the quarterly steps land on Feb — the one month of
    // the four that has to clamp. The other three keep the 30th.
    const got = occurrencesIn(every("quarter", "2025-11-30"), ALWAYS, d("2025-11-01"), d("2026-12-01"));
    assert.deepEqual(days(got), ["2025-11-30", "2026-02-28", "2026-05-30", "2026-08-30", "2026-11-30"]);
  });
});

describe("fortnightly items keep their phase", () => {
  const fortnightly = every("week", "2026-01-01", 2); // a Thursday

  test("a fortnightly wage stays on its own fortnight across a month boundary", () => {
    // Resetting phase at the month boundary is the tempting shortcut, and it
    // silently invents or loses a payday roughly every other month.
    const got = occurrencesIn(fortnightly, ALWAYS, d("2026-01-01"), d("2026-03-01"));
    assert.deepEqual(days(got), [
      "2026-01-01",
      "2026-01-15",
      "2026-01-29",
      "2026-02-12",
      "2026-02-26",
    ]);
  });

  test("a month can hold three paydays, and the arithmetic says so", () => {
    // The whole reason budgets expand to dates instead of using a monthly rate:
    // 26 fortnights do not divide into 12 months, so some months genuinely carry
    // three. A smoothed ×2.17 would describe a month that never happens.
    const july = occurrencesIn(fortnightly, ALWAYS, d("2026-07-01"), d("2026-08-01"));
    assert.equal(july.length, 3);
    assert.deepEqual(days(july), ["2026-07-02", "2026-07-16", "2026-07-30"]);
  });

  test("every occurrence falls on the anchor's weekday", () => {
    const got = occurrencesIn(fortnightly, ALWAYS, d("2026-01-01"), d("2027-01-01"));
    const weekday = d("2026-01-01").getUTCDay();
    for (const date of got) assert.equal(date.getUTCDay(), weekday);
  });
});

describe("NZ daylight saving does not move an occurrence", () => {
  // NZDT starts late September and ends early April. An implementation that did
  // its arithmetic in local time would gain or lose an hour across those
  // boundaries and, on a midnight-anchored date, land on the wrong day.
  test("a daily item crosses the September transition one day at a time", () => {
    const got = occurrencesIn(every("day", "2026-09-25"), ALWAYS, d("2026-09-25"), d("2026-10-01"));
    assert.deepEqual(days(got), [
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
    ]);
  });

  test("a weekly item crosses the April transition on the same weekday", () => {
    const got = occurrencesIn(every("week", "2026-03-26"), ALWAYS, d("2026-03-26"), d("2026-04-24"));
    assert.deepEqual(days(got), ["2026-03-26", "2026-04-02", "2026-04-09", "2026-04-16", "2026-04-23"]);
  });
});

describe("a lifespan decides which days a budget applies on", () => {
  const bounded = (from: string, to: string, repeatsAnnually = false): Lifespan => ({
    startsOn: d(from),
    endsOn: d(to),
    repeatsAnnually,
  });

  test("an open-ended budget is always active", () => {
    assert.equal(activeOn(ALWAYS, d("1999-01-01")), true);
    assert.equal(activeOn(ALWAYS, d("2099-12-31")), true);
  });

  test("a fixed window is inclusive at both ends", () => {
    const christmas = bounded("2026-12-01", "2026-12-25");
    assert.equal(activeOn(christmas, d("2026-11-30")), false);
    assert.equal(activeOn(christmas, d("2026-12-01")), true, "the first day is in");
    assert.equal(activeOn(christmas, d("2026-12-25")), true, "the last day is in");
    assert.equal(activeOn(christmas, d("2026-12-26")), false);
  });

  test("a half-bounded window is unbounded on its open side", () => {
    const from = { startsOn: d("2026-03-01"), endsOn: null, repeatsAnnually: false };
    assert.equal(activeOn(from, d("2026-02-28")), false);
    assert.equal(activeOn(from, d("2099-01-01")), true);

    const until = { startsOn: null, endsOn: d("2026-03-01"), repeatsAnnually: false };
    assert.equal(activeOn(until, d("1999-01-01")), true);
    assert.equal(activeOn(until, d("2026-03-02")), false);
  });

  test("an annual window matches in later years, ignoring its own", () => {
    const christmas = bounded("2026-12-01", "2026-12-25", true);
    assert.equal(activeOn(christmas, d("2029-12-10")), true);
    assert.equal(activeOn(christmas, d("2029-11-30")), false);
    assert.equal(activeOn(christmas, d("2029-12-26")), false);
  });

  test("an annual window that wraps the New Year stays active in January", () => {
    // The case that fails silently: with a naive between-test the budget simply
    // stops at midnight on 31 December, and January's share of it vanishes.
    const holiday = bounded("2026-12-15", "2027-01-05", true);
    assert.equal(activeOn(holiday, d("2026-12-20")), true, "before New Year");
    assert.equal(activeOn(holiday, d("2026-12-31")), true, "New Year's Eve");
    assert.equal(activeOn(holiday, d("2027-01-02")), true, "after New Year");
    assert.equal(activeOn(holiday, d("2030-01-04")), true, "and in a later year");
    assert.equal(activeOn(holiday, d("2027-01-06")), false, "but not past the end");
    assert.equal(activeOn(holiday, d("2026-12-14")), false, "nor before the start");
  });

  test("repeatsAnnually is ignored when the window is open-ended", () => {
    // "From March onwards, every year" describes nothing, so it falls back to the
    // plain bounded test rather than inventing a meaning for it.
    const half = { startsOn: d("2026-03-01"), endsOn: null, repeatsAnnually: true };
    assert.equal(activeOn(half, d("2026-02-01")), false);
    assert.equal(activeOn(half, d("2027-02-01")), true, "later years are simply after the start");
  });
});

describe("occurrences are clipped to the lifespan", () => {
  test("a seasonal budget contributes only inside its own window", () => {
    // A monthly item in a December-only budget must not spend all year, even
    // though the item itself recurs monthly.
    const christmas: Lifespan = { startsOn: d("2026-12-01"), endsOn: d("2026-12-25"), repeatsAnnually: false };
    const got = occurrencesIn(every("month", "2026-01-05"), christmas, d("2026-01-01"), d("2027-01-01"));
    assert.deepEqual(days(got), ["2026-12-05"]);
  });

  test("an annually repeating window contributes once per year", () => {
    const christmas: Lifespan = { startsOn: d("2026-12-01"), endsOn: d("2026-12-25"), repeatsAnnually: true };
    const got = occurrencesIn(every("month", "2026-01-05"), christmas, d("2026-01-01"), d("2029-01-01"));
    assert.deepEqual(days(got), ["2026-12-05", "2027-12-05", "2028-12-05"]);
  });

  test("a wrapping window lets a weekly item run through January", () => {
    const holiday: Lifespan = { startsOn: d("2026-12-20"), endsOn: d("2027-01-10"), repeatsAnnually: true };
    const got = occurrencesIn(every("week", "2026-12-24"), holiday, d("2026-12-01"), d("2027-02-01"));
    assert.deepEqual(days(got), ["2026-12-24", "2026-12-31", "2027-01-07"]);
  });
});

describe("a base projects with its date-active layers", () => {
  // The contract the base ↔ layer model rests on, exercised the way both the
  // breakdown builder and the forecast walk do it: expand the base and each of its
  // layers over the same span, each gated by *its own* lifespan, and sum. A base is
  // always-on here; two layers hang off it — a Christmas top-up (annual window) and
  // a one-off winter trip. Nothing overrides anything; a layer is spend *on top of*
  // the base, and only while its own window is live.
  const base = ALWAYS;
  const christmasLayer: Lifespan = {
    startsOn: d("2026-12-01"),
    endsOn: d("2026-12-25"),
    repeatsAnnually: true,
  };
  const tripLayer: Lifespan = {
    startsOn: d("2026-07-01"),
    endsOn: d("2026-07-14"),
    repeatsAnnually: false,
  };

  /** Base + both layers, totalled over a span the way the walk sums day flows. */
  const spentIn = (from: string, to: string) => {
    const lines: [Recurrence, Lifespan, number][] = [
      [every("month", "2026-01-05"), base, 800], // everyday, from the base
      [every("month", "2026-12-10"), christmasLayer, 300], // Christmas top-up layer
      [every("once", "2026-07-04"), tripLayer, 500], // the trip, a one-off layer
    ];
    return lines.reduce(
      (total, [recurrence, lifespan, amount]) =>
        total + occurrencesIn(recurrence, lifespan, d(from), d(to)).length * amount,
      0,
    );
  };

  test("an ordinary month is the base alone", () => {
    assert.equal(spentIn("2026-09-01", "2026-10-01"), 800, "no layer's window is live");
  });

  test("the trip month adds only the trip layer", () => {
    assert.equal(spentIn("2026-07-01", "2026-08-01"), 1300, "800 base + 500 trip");
  });

  test("December adds only the Christmas layer", () => {
    assert.equal(spentIn("2026-12-01", "2027-01-01"), 1100, "800 base + 300 Christmas");
  });

  test("the annual layer returns next December, the one-off trip does not", () => {
    assert.equal(spentIn("2027-07-01", "2027-08-01"), 800, "trip was a one-off");
    assert.equal(spentIn("2027-12-01", "2028-01-01"), 1100, "Christmas repeats");
  });
});

describe("layering is addition", () => {
  // The rule the whole feature rests on, exercised at the level the breakdown
  // builder does it: expand each budget over the same span and sum. There is no
  // precedence between budgets and no override — a seasonal layer is what is
  // spent *on top of* ordinary life.
  const general = ALWAYS;
  const christmas: Lifespan = {
    startsOn: d("2026-12-01"),
    endsOn: d("2026-12-25"),
    repeatsAnnually: true,
  };

  /** The three Food items across two budgets, totalled over one month the way
   *  the breakdown builder totals them: expand, count, multiply, sum. */
  const foodIn = (from: string, to: string) => {
    const lines: [Recurrence, Lifespan, number][] = [
      [every("month", "2026-01-05"), general, 800], // everyday food
      [every("month", "2026-12-10"), christmas, 300], // Christmas top-up
      [every("once", "2026-12-20"), christmas, 800], // presents, a one-off
    ];
    return lines.reduce(
      (total, [recurrence, lifespan, amount]) =>
        total + occurrencesIn(recurrence, lifespan, d(from), d(to)).length * amount,
      0,
    );
  };

  test("November is the general budget alone", () => {
    assert.equal(foodIn("2026-11-01", "2026-12-01"), 800);
  });

  test("December is the general budget plus the seasonal one, not instead of it", () => {
    assert.equal(foodIn("2026-12-01", "2027-01-01"), 1900, "800 everyday + 300 top-up + 800 presents");
  });

  test("the seasonal budget returns next December, but its one-off does not", () => {
    // `once` happens once, however often the window it sits in repeats.
    assert.equal(foodIn("2027-12-01", "2028-01-01"), 1100, "800 everyday + 300 top-up, no presents");
  });
});

describe("currentOrNextWindow picks the instance a reader means", () => {
  const christmas: Lifespan = {
    startsOn: d("2026-12-01"),
    endsOn: d("2026-12-25"),
    repeatsAnnually: true,
  };

  test("an open-ended budget has no window instance", () => {
    assert.equal(currentOrNextWindow(ALWAYS, d("2026-06-01")), null);
  });

  test("a one-off window is simply itself, and its length is inclusive", () => {
    const trip: Lifespan = { startsOn: d("2027-01-12"), endsOn: d("2027-01-26"), repeatsAnnually: false };
    const got = currentOrNextWindow(trip, d("2026-06-01"))!;
    assert.equal(got.from.toISOString().slice(0, 10), "2027-01-12");
    assert.equal(got.to.toISOString().slice(0, 10), "2027-01-26");
    assert.equal(got.days, 15, "12 Jan to 26 Jan inclusive is 15 days");
  });

  test("mid-year, a repeating window resolves to this year's instance", () => {
    const got = currentOrNextWindow(christmas, d("2026-06-01"))!;
    assert.equal(got.from.toISOString().slice(0, 10), "2026-12-01");
    assert.equal(got.days, 25);
  });

  test("inside the window, it resolves to the instance in progress", () => {
    const got = currentOrNextWindow(christmas, d("2026-12-10"))!;
    assert.equal(got.from.toISOString().slice(0, 10), "2026-12-01");
  });

  test("after it closes, it rolls to next year", () => {
    const got = currentOrNextWindow(christmas, d("2026-12-26"))!;
    assert.equal(got.from.toISOString().slice(0, 10), "2027-12-01");
  });

  test("a wrapping window opened last year is still the current instance", () => {
    // Standing on 2 January, the window that matters started in December — the
    // one that has not ended yet, not the one due in eleven months.
    const holiday: Lifespan = {
      startsOn: d("2026-12-15"),
      endsOn: d("2027-01-05"),
      repeatsAnnually: true,
    };
    const got = currentOrNextWindow(holiday, d("2027-01-02"))!;
    assert.equal(got.from.toISOString().slice(0, 10), "2026-12-15");
    assert.equal(got.to.toISOString().slice(0, 10), "2027-01-05");
    assert.equal(got.days, 22);
  });
});

describe("nextOccurrence", () => {
  test("finds the next one on or after a date", () => {
    const next = nextOccurrence(every("month", "2026-01-01"), ALWAYS, d("2026-03-15"));
    assert.equal(next?.toISOString().slice(0, 10), "2026-04-01");
  });

  test("returns null when the budget never applies again", () => {
    const past: Lifespan = { startsOn: d("2020-01-01"), endsOn: d("2020-12-31"), repeatsAnnually: false };
    assert.equal(nextOccurrence(every("month", "2020-01-01"), past, d("2026-01-01")), null);
  });
});

describe("cadence reads back in words", () => {
  test("names the shapes a person would recognise", () => {
    assert.equal(describeRecurrence(every("month", "2026-01-01")), "Monthly, on the 1st");
    assert.equal(describeRecurrence(every("month", "2026-01-22")), "Monthly, on the 22nd");
    // week × 2 is stored as an interval but named the way people say it.
    assert.equal(describeRecurrence(every("week", "2026-01-01", 2)), "Fortnightly, on Thursday");
    assert.equal(describeRecurrence(every("week", "2026-01-01")), "Weekly on Thursday");
    assert.equal(describeRecurrence(every("year", "2026-07-09")), "Yearly, on 9 July");
    assert.equal(describeRecurrence(every("once", "2026-12-20")), "Once, on 20 December 2026");
  });

  test("ordinals handle the teens", () => {
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal), [
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st",
    ]);
  });

  test("lifespans read back too", () => {
    assert.equal(describeLifespan(ALWAYS), "Always on");
    assert.equal(
      describeLifespan({ startsOn: d("2026-12-01"), endsOn: d("2026-12-25"), repeatsAnnually: true }),
      "1 Dec – 25 Dec, yearly",
    );
    assert.equal(
      describeLifespan({ startsOn: d("2027-01-12"), endsOn: d("2027-01-26"), repeatsAnnually: false }),
      "12 Jan 2027 – 26 Jan 2027",
    );
  });
});

describe("detectRecurrence finds real cadences and refuses the rest", () => {
  /** Dates from a list of `YYYY-MM-DD`. */
  const on = (...days: string[]) => days.map(d);

  /** `count` dates stepping `stepDays` from `first`. */
  const every_ = (first: string, stepDays: number, count: number) =>
    Array.from({ length: count }, (_, i) => new Date(d(first).getTime() + i * stepDays * 86_400_000));

  test("a monthly bill whose gaps run 28–31 days is detected as monthly", () => {
    // The case that decides whether the seeder is worth having. Real monthly
    // bills drift with month length, so a detector built on an exact 30-day gap
    // discards most true positives and finds almost nothing.
    const got = detectRecurrence(
      on(
        "2025-01-15", "2025-02-15", "2025-03-15", "2025-04-15", "2025-05-15",
        "2025-06-15", "2025-07-15", "2025-08-15", "2025-09-15", "2025-10-15",
        "2025-11-15", "2025-12-15",
      ),
    );
    assert.equal(got?.frequency, "month");
    assert.equal(got?.interval, 1);
    assert.equal(got?.occurrences, 12);
  });

  test("a fortnightly wage is week x 2, not a fortnight of its own", () => {
    const got = detectRecurrence(every_("2026-01-01", 14, 12));
    assert.equal(got?.frequency, "week");
    assert.equal(got?.interval, 2);
  });

  test("a weekly shop is weekly", () => {
    const got = detectRecurrence(every_("2026-01-05", 7, 20));
    assert.equal(got?.frequency, "week");
    assert.equal(got?.interval, 1);
  });

  test("a quarterly charge is quarterly", () => {
    const got = detectRecurrence(on("2025-01-20", "2025-04-20", "2025-07-20", "2025-10-20", "2026-01-20"));
    assert.equal(got?.frequency, "quarter");
    assert.equal(got?.interval, 1);
  });

  test("an annual premium seen three times in 24 months is yearly", () => {
    const got = detectRecurrence(on("2024-03-11", "2025-03-12", "2026-03-10"));
    assert.equal(got?.frequency, "year");
    assert.equal(got?.interval, 1);
  });

  test("two occurrences are never enough", () => {
    // One gap is consistent with itself by construction, so it is no evidence of
    // a rhythm at all.
    assert.equal(detectRecurrence(on("2026-01-01", "2026-02-01")), null);
  });

  test("uneven gaps are rejected rather than averaged into a cadence", () => {
    assert.equal(detectRecurrence(on("2026-01-03", "2026-01-09", "2026-03-27", "2026-04-02")), null);
  });

  test("a rhythm we have no name for is rejected, not snapped to the nearest", () => {
    // Every 45 days is regular, but it is neither monthly nor two-monthly, and
    // calling it either would misstate the money in every period.
    assert.equal(detectRecurrence(every_("2026-01-01", 45, 6)), null);
  });

  test("same-day rows are one event, not a daily cadence", () => {
    const sameDay = on("2026-01-01", "2026-01-01", "2026-01-01");
    assert.equal(detectRecurrence(sameDay), null);
  });

  test("spread reports how metronomic a stream is", () => {
    assert.equal(detectRecurrence(every_("2026-01-01", 7, 8))?.spreadDays, 0);
    assert.ok((detectRecurrence(on("2025-01-31", "2025-03-02", "2025-03-31", "2025-05-01"))?.spreadDays ?? 0) > 0);
  });
});

describe("isCurrent tells a live rhythm from one that has lapsed", () => {
  const on = (...days: string[]) => days.map(d);
  const every_ = (first: string, stepDays: number, count: number) =>
    Array.from({ length: count }, (_, i) => new Date(d(first).getTime() + i * stepDays * 86_400_000));

  /** detectRecurrence then isCurrent, the way the seeder runs them. */
  const live = (dates: Date[], now: string) => {
    const detected = detectRecurrence(dates);
    assert.ok(detected, "expected a cadence to test liveness against");
    return isCurrent(dates, detected, d(now));
  };

  test("a monthly salary still paying this month is current", () => {
    const wage = on(
      "2025-01-15", "2025-02-15", "2025-03-15", "2025-04-15", "2025-05-15", "2025-06-15",
    );
    assert.equal(live(wage, "2025-07-01"), true);
  });

  test("a monthly salary last paid five months ago has lapsed", () => {
    // The Autodesk case: a clean monthly rhythm that stopped in February. The
    // rhythm is real, so detection still finds it — liveness is what refuses it.
    const wage = on(
      "2025-09-15", "2025-10-15", "2025-11-15", "2025-12-15", "2026-01-15", "2026-02-15",
    );
    assert.equal(live(wage, "2026-07-25"), false);
  });

  test("a monthly bill a fortnight late is not yet lapsed", () => {
    // 1.5 cycles of slack: still expecting the next one, not writing it off.
    const bill = on("2026-01-10", "2026-02-10", "2026-03-10", "2026-04-10");
    assert.equal(live(bill, "2026-05-24"), true);
  });

  test("a weekly stream silent for a month has lapsed", () => {
    assert.equal(live(every_("2026-01-05", 7, 8), "2026-03-20"), false);
  });

  test("a yearly premium is current for most of the year after it is paid", () => {
    // A long cadence must not be called lapsed just because months have passed —
    // that is a normal gap for it.
    const premium = on("2024-03-11", "2025-03-12", "2026-03-10");
    assert.equal(live(premium, "2026-09-01"), true);
  });
});

describe("detectRate finds habits that gap analysis cannot", () => {
  const noWeeks = Array.from({ length: 12 }, () => 0);
  const noMonths = Array.from({ length: 6 }, () => 0);

  test("a weekly shop active every week is weekly, sized by its median", () => {
    // The Woolworths case: ~$500 every week, irregular within the week, which the
    // gap detector rejects and this rescues.
    const got = detectRate(Array.from({ length: 12 }, () => -500), noMonths);
    assert.equal(got?.frequency, "week");
    assert.equal(got?.amount, -500);
  });

  test("a handful of skipped weeks is still weekly", () => {
    const totals = [-500, -480, 0, -520, -510, -500, 0, -490, -505, -500, -495, -500]; // 10 of 12
    assert.equal(detectRate(totals, noMonths)?.frequency, "week");
  });

  test("present most months but few weeks is monthly, not weekly", () => {
    const weeks = [-500, 0, 0, -500, 0, 0, -500, 0, 0, -500, 0, -500]; // 5 of 12, below the weekly bar
    const months = [-1000, -900, -1100, -1000, -950, -1000]; // every month
    const got = detectRate(weeks, months);
    assert.equal(got?.frequency, "month");
    assert.equal(got?.amount, -1000);
  });

  test("weekly wins when both cadences would qualify", () => {
    const got = detectRate(Array.from({ length: 12 }, () => -500), Array.from({ length: 6 }, () => -2000));
    assert.equal(got?.frequency, "week");
  });

  test("a habit silent across the recent window is neither — a stopped shop is not budgeted", () => {
    assert.equal(detectRate(noWeeks, noMonths), null);
  });

  test("too sparse to be either is null", () => {
    const weeks = [0, 0, -500, 0, 0, 0, -500, 0, 0, 0, 0, -500]; // 3 of 12
    const months = [0, 0, -500, 0, -500, 0]; // 2 of 6
    assert.equal(detectRate(weeks, months), null);
  });
});

describe("detectAmount and detectAnchor describe a normal one", () => {
  test("the amount is the median, so one freak bill does not move the budget", () => {
    // The mean of these is 320; no month has ever looked like that.
    assert.equal(detectAmount([-180, -190, -185, -1000, -175]), -185);
  });

  test("a monthly anchor takes the typical day of the month, not the last one", () => {
    // Eleven payments on the 1st and one that slipped to the 5th: the budget
    // belongs on the 1st, even though the 5th is the most recent.
    const dates = [
      ...Array.from({ length: 11 }, (_, i) => d(`2025-${String(i + 1).padStart(2, "0")}-01`)),
      d("2025-12-05"),
    ];
    assert.equal(detectAnchor(dates, "month").toISOString().slice(0, 10), "2025-12-01");
  });

  test("a weekly anchor takes the typical weekday", () => {
    const thursdays = Array.from({ length: 6 }, (_, i) => new Date(d("2026-01-01").getTime() + i * 7 * 86_400_000));
    // One payment slipped to a Saturday; the anchor should stay Thursday.
    thursdays.push(new Date(d("2026-02-14").getTime()));
    const anchor = detectAnchor(thursdays, "week");
    assert.equal(anchor.getUTCDay(), 4, "Thursday");
  });

  test("a month-end anchor clamps rather than rolling into the next month", () => {
    const dates = [d("2026-01-31"), d("2026-03-31"), d("2026-02-28")];
    const anchor = detectAnchor(dates, "month");
    // Most recent is 31 March; the typical day is the 31st, and March has one.
    assert.equal(anchor.toISOString().slice(0, 10), "2026-03-31");
  });
});

describe("isFrequency guards the stored string", () => {
  test("accepts the six, rejects a period that isn't one", () => {
    for (const f of ["once", "day", "week", "month", "quarter", "year"]) {
      assert.equal(isFrequency(f), true, f);
    }
    // `taxyear` is a Period but not a budget frequency, and `fortnight` is week×2.
    assert.equal(isFrequency("taxyear"), false);
    assert.equal(isFrequency("fortnight"), false);
  });
});

// --- the projection -------------------------------------------------------
//
// `walkProjection` turns a scenario's daily cash flows into the dashed line, the
// date the money runs out and the monthly rate the runway tile reads. Every one
// of those is a claim about the future stated to the day, which is exactly the
// kind of number nobody checks — so the cases below pin the three rules that
// decide it: the crossing lands on the day the balance really goes under, a
// constant rate stays one straight segment, and switching income off can only
// ever make a line steeper.

/** A scenario's day-by-day flows, from a list of `[day, amount]` movements. */
function flows(days: number, movements: [number, number][]) {
  const nets = new Array<number>(days).fill(0);
  const outs = new Array<number>(days).fill(0);
  const ins = new Array<number>(days).fill(0);
  for (const [day, amount] of movements) {
    nets[day] += amount;
    if (amount > 0) ins[day] += amount;
    else outs[day] += -amount;
  }
  return { nets, outs, ins };
}

const FROM = d("2026-08-01");

describe("walkProjection finds the day the money runs out", () => {
  test("the crossing is the day the running balance first goes under", () => {
    // $1,000, spending $400 on days 0, 1 and 2. It survives two and dies on the
    // third — the third is the answer, not the second and not the fourth.
    const { nets, outs, ins } = flows(10, [
      [0, -400],
      [1, -400],
      [2, -400],
    ]);
    const walk = walkProjection(nets, outs, ins, 1000, FROM);

    assert.equal(walk.depletionDay, "2026-08-03");
    // The line stops on the axis rather than dipping below it: the crossing
    // happens partway through the day, and 200 of the day's 400 spends it.
    const last = walk.points[walk.points.length - 1];
    assert.equal(last.worth, 0);
    assert.ok(Math.abs(last.day - 2.5) < 1e-9, `crossed at ${last.day}`);
  });

  test("a plan that pays for itself never depletes", () => {
    const { nets, outs, ins } = flows(30, [
      [0, 3000],
      [15, -1000],
    ]);
    const walk = walkProjection(nets, outs, ins, 1000, FROM);

    assert.equal(walk.depletionDay, null);
    assert.equal(walk.months, Infinity);
    assert.ok(walk.monthlyBurn! < 0, "a surplus is a negative burn");
  });

  test("still solvent at the horizon carries on at the average rate", () => {
    // $100 a day out of $10,000 over a 10-day window: 90 days of runway in all,
    // of which the walk covers 10 and the extrapolation covers the rest.
    const nets = new Array<number>(10).fill(-100);
    const outs = new Array<number>(10).fill(100);
    const ins = new Array<number>(10).fill(0);
    const walk = walkProjection(nets, outs, ins, 10_000, FROM);

    assert.equal(walk.depletionDay, null);
    const days = walk.months! * (365.25 / 12);
    assert.ok(Math.abs(days - 100) < 1e-6, `${days} days`);
  });
});

describe("a constant rate stays one straight segment", () => {
  test("a flat daily net collapses to a single vertex", () => {
    // This is the no-scenario fallback: without the collapse the same line would
    // ship a vertex per day, and the promise that a workspace with no budgets
    // gets exactly the old straight dash would be quietly untrue.
    const nets = new Array<number>(400).fill(-10);
    const outs = new Array<number>(400).fill(10);
    const ins = new Array<number>(400).fill(0);
    const walk = walkProjection(nets, outs, ins, 100_000, FROM);

    assert.equal(walk.points.length, 1);
    assert.deepEqual(walk.points[0], { day: 400, worth: 96_000 });
  });

  test("a change of rate earns a vertex, and only there", () => {
    const nets = [...new Array<number>(10).fill(-10), ...new Array<number>(10).fill(-50)];
    const outs = nets.map((n) => -n);
    const ins = new Array<number>(20).fill(0);
    const walk = walkProjection(nets, outs, ins, 100_000, FROM);

    assert.deepEqual(walk.points, [
      { day: 10, worth: 99_900 },
      { day: 20, worth: 99_400 },
    ]);
  });
});

describe("switching income off makes a line strictly steeper", () => {
  test("the same plan without its income runs dry sooner", () => {
    // A fortnightly wage against a daily spend — the emergency question: what if
    // the money stops arriving. Income is dropped whole, not reduced, so the two
    // lines differ by exactly the wage.
    const movements: [number, number][] = [];
    for (let day = 0; day < 200; day++) movements.push([day, -200]);
    const withIncome: [number, number][] = [...movements];
    for (let day = 3; day < 200; day += 14) withIncome.push([day, 1600]);

    const a = flows(200, withIncome);
    const b = flows(200, movements);
    const rich = walkProjection(a.nets, a.outs, a.ins, 5000, FROM);
    const poor = walkProjection(b.nets, b.outs, b.ins, 5000, FROM);

    assert.ok(poor.monthlyBurn! > rich.monthlyBurn!, "burning faster");
    assert.equal(rich.monthlyIn > 0, true);
    assert.equal(poor.monthlyIn, 0);
    // Both run out, and the one with no income gets there first. $5,000 at $200
    // a day is twenty-five days, so the twenty-fifth is the day it goes under.
    assert.equal(poor.depletionDay, "2026-08-25");
    assert.ok(rich.depletionDay !== null, "the wage delays it, it does not save it");
    assert.ok(poor.depletionDay! < rich.depletionDay!, `${poor.depletionDay} < ${rich.depletionDay}`);
  });

  test("the outflow half is unchanged by the income switch", () => {
    // What the switch must *not* do is quietly change the spending side, which is
    // how "assume no income" would turn into "assume a different plan".
    const spend: [number, number][] = [
      [0, -500],
      [30, -500],
    ];
    const a = flows(60, [...spend, [10, 2000]]);
    const b = flows(60, spend);
    const rich = walkProjection(a.nets, a.outs, a.ins, 5000, FROM);
    const poor = walkProjection(b.nets, b.outs, b.ins, 5000, FROM);

    assert.equal(rich.monthlyOut, poor.monthlyOut);
  });
});

describe("the monthly rate describes the plan, not the walk", () => {
  test("a burn that outlives the balance still reports its own rate", () => {
    // $200 a day is $6,088 a month whether or not the balance survives the month.
    // Measuring the drop instead would report the burn of the 25 days it lasted.
    const nets = new Array<number>(200).fill(-200);
    const outs = new Array<number>(200).fill(200);
    const ins = new Array<number>(200).fill(0);
    const walk = walkProjection(nets, outs, ins, 5000, FROM);

    assert.equal(walk.depletionDay, "2026-08-25");
    assert.ok(Math.abs(walk.monthlyBurn! - 200 * (365.25 / 12)) < 1e-9, `${walk.monthlyBurn}`);
    // And the three figures the legend shows add up, which is the same rule.
    assert.equal(walk.monthlyBurn, walk.monthlyOut - walk.monthlyIn);
  });
});

// The forward bars on the balance chart are one grey bar a day, not one per
// forecast budget: bars root at the same $0 line, so drawing four scenarios'
// worth of them would stack into a figure nobody planned. `averageDailyNets` is
// the arithmetic that makes them one, and the two things it has to get right are
// that a day is averaged and not summed, and that a scenario which stops short
// does not drag the days past its end toward zero.
describe("the planned bars average the forecasts, one bar a day", () => {
  test("a day is the mean of the scenarios' flows, not their total", () => {
    const avg = averageDailyNets([
      [-100, -200, 0],
      [-300, 0, 0],
    ]);
    assert.deepEqual(avg, [-200, -100, 0]);
  });

  test("a day only the longer scenario reaches is that scenario's own flow", () => {
    // The six-month plan beside the two-year one must not halve month seven
    // onward: past its end there is nothing of its to average in.
    const avg = averageDailyNets([
      [-100, -100, -100],
      [-300],
    ]);
    assert.deepEqual(avg, [-200, -100, -100]);
  });

  test("no forecasts at all is no bars, not a row of zeroes", () => {
    assert.deepEqual(averageDailyNets([]), []);
  });
});

describe("refining a budget pulls each figure halfway to its actual", () => {
  const WINDOW = 182.64; // six average months, the refine window

  test("blendTowardActual is the midpoint, no more", () => {
    assert.equal(blendTowardActual(-500, -600), -550);
    assert.equal(blendTowardActual(-500, -500), -500);
    assert.equal(blendTowardActual(3000, 3400), 3200);
  });

  test("a weekly item reads its actual as the average week over the window", () => {
    // ~26 weeks of −600 spend against a −500 budget: the actual is about −600
    // (the window is 26.1 weeks, not a clean 26), and the blend lands halfway near
    // −550. Tolerances, because six average months is not a whole number of weeks.
    const amounts = Array.from({ length: 26 }, () => -600);
    assert.ok(Math.abs(actualPerOccurrence(amounts, "week", 1, WINDOW)! - -600) < 3);
    assert.ok(Math.abs(refinedAmount(-500, amounts, "week", 1, WINDOW)! - -550) < 2);
  });

  test("a fortnightly item divides the window into fortnights, not weeks", () => {
    // 13 fortnights of −500 over six months is about the −500 budget, so it barely
    // moves — which only holds because the divisor is interval-aware. Read as weekly
    // the same spend would look like half the rate and the budget would nearly halve.
    const amounts = Array.from({ length: 13 }, () => -500);
    assert.ok(Math.abs(refinedAmount(-500, amounts, "week", 2, WINDOW)! - -500) < 2);
    assert.ok(refinedAmount(-500, amounts, "week", 1, WINDOW)! > -400);
  });

  test("a monthly item reads its actual as the average month", () => {
    const amounts = Array.from({ length: 6 }, () => -1200);
    assert.equal(refinedAmount(-1000, amounts, "month", 1, WINDOW), -1100);
  });

  test("an item the window is silent on is left alone, not halved", () => {
    // The literal rule mean(budgeted, 0) would halve an annual premium that simply
    // did not fall in a six-month window. Null instead: do not refine it.
    assert.equal(actualPerOccurrence([], "year", 1, WINDOW), null);
    assert.equal(refinedAmount(-800, [], "year", 1, WINDOW), null);
  });

  test("a one-off has no rate to refine toward", () => {
    assert.equal(refinedAmount(-200, [-200], "once", 1, WINDOW), null);
  });

  test("income refines the same way, keeping its positive sign", () => {
    const amounts = Array.from({ length: 6 }, () => 3400);
    assert.equal(refinedAmount(3000, amounts, "month", 1, WINDOW), 3200);
  });

  test("the blended figure is rounded to the cent", () => {
    // Three −100 weeks over the window average to an odd per-week figure; the
    // result carries cents, not a long tail.
    const amounts = [-100, -100, -100];
    const refined = refinedAmount(-50, amounts, "week", 1, WINDOW)!;
    assert.equal(Math.round(refined * 100) / 100, refined);
  });
});
