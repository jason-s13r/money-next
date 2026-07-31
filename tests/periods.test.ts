import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  fetchCutoff,
  formatPeriodKey,
  formatPeriodShort,
  isPeriod,
  nzDate,
  offsetForStartDate,
  PERIODS,
  periodEnd,
  periodKey,
  periodStart,
  periodWindow,
  type Period,
} from "../lib/periods";

/**
 * The bucketing every comparison and breakdown is built on.
 *
 * Worth testing because every failure here is a *quiet* one. A transaction put in
 * the wrong bucket does not throw; it makes a monthly total slightly wrong, in a
 * chart nobody can check by eye. Three specific things go wrong quietly:
 *
 *   - **The timezone.** Banks stamp most transactions at midday UTC, which is
 *     evening in Auckland — so under UTC bucketing hundreds of rows land in the
 *     previous day, enough to visibly move a month.
 *   - **The ISO week year.** In late December and early January it differs from
 *     the calendar year, which is exactly why the code isn't `ceil(day / 7)`.
 *   - **The tax year.** It runs April–March and is named for the year it *ends*
 *     in, so every boundary case is off by one in one direction or the other.
 *
 * The round-trip properties at the end are the ones that catch a whole class of
 * mistake at once: whatever `periodKey` decides, `periodStart` and `periodEnd`
 * have to agree with it, or a window's filter and its labels describe different
 * spans.
 */

/**
 * An instant that is unambiguously the given *NZ* calendar day.
 *
 * Midnight UTC, because NZ is +12 or +13 — so this lands at midday or 1pm on the
 * same NZ date, comfortably inside it either side of a daylight-saving change.
 * Written this way rather than as a local-time string because the assertions below
 * are about which NZ day an instant belongs to, and constructing the instant from
 * an NZ wall clock would beg the question.
 */
const nzDay = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Midday UTC: how a bank actually stamps a transaction, and — in NZ — the evening
 *  of that day or the early hours of the *next* one. The reason this module exists. */
const middayUtc = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("nzDate", () => {
  test("resolves the NZ calendar day, not the UTC one", () => {
    // 23:00 UTC on 14 July is 11am on the 15th in Auckland (NZST, +12).
    assert.deepEqual(nzDate(new Date("2026-07-14T23:00:00Z")), {
      year: 2026,
      month: 7,
      day: 15,
    });
  });

  test("follows daylight saving, which is +13 in the southern summer", () => {
    // 11:00 UTC on 31 December is midnight on 1 January in Auckland (NZDT).
    assert.deepEqual(nzDate(new Date("2026-12-31T11:00:00Z")), {
      year: 2027,
      month: 1,
      day: 1,
    });
    // An hour earlier is still the old year.
    assert.deepEqual(nzDate(new Date("2026-12-31T10:00:00Z")), {
      year: 2026,
      month: 12,
      day: 31,
    });
  });
});

describe("periodKey", () => {
  const date = nzDay("2026-07-14"); // a Tuesday in NZ

  test("every period's shape", () => {
    assert.equal(periodKey(date, "day"), "2026-07-14");
    assert.equal(periodKey(date, "week"), "2026-W29");
    assert.equal(periodKey(date, "month"), "2026-07");
    assert.equal(periodKey(date, "quarter"), "2026-Q3");
    assert.equal(periodKey(date, "year"), "2026");
    assert.equal(periodKey(date, "taxyear"), "FY2027");
  });

  test("a bank's midday-UTC stamp buckets to the NZ day, which is the next one", () => {
    // The whole reason the module resolves an explicit timezone. Under UTC
    // bucketing this row would land on the 14th; in Auckland it is the 15th, and
    // at the end of a month that is the difference between two monthly totals.
    assert.equal(periodKey(middayUtc("2026-07-14"), "day"), "2026-07-15");
    assert.equal(periodKey(middayUtc("2026-06-30"), "month"), "2026-07");
    assert.equal(periodKey(middayUtc("2026-12-31"), "year"), "2027");
  });

  test("keys sort lexicographically in time order, which is what they are for", () => {
    for (const period of PERIODS) {
      const keys = periodWindow(date, period, 6);
      assert.deepEqual(keys, [...keys].sort(), `${period} keys are not sorted`);
    }
  });

  test("months and quarters are zero-padded so they sort", () => {
    const march = nzDay("2026-03-10");
    assert.equal(periodKey(march, "month"), "2026-03");
    assert.ok("2026-03" < "2026-11", "a padded month sorts before a two-digit one");
  });

  test("the quarter boundaries", () => {
    assert.equal(periodKey(nzDay("2026-03-30"), "quarter"), "2026-Q1");
    assert.equal(periodKey(nzDay("2026-04-02"), "quarter"), "2026-Q2");
    assert.equal(periodKey(nzDay("2026-06-29"), "quarter"), "2026-Q2");
    assert.equal(periodKey(nzDay("2026-07-02"), "quarter"), "2026-Q3");
  });
});

describe("the ISO week year", () => {
  test("early January can belong to the previous year's last week", () => {
    // 1 Jan 2027 is a Friday, so it falls in the week that began Mon 28 Dec 2026 —
    // ISO week 53 of 2026, not week 1 of 2027.
    assert.equal(periodKey(nzDay("2027-01-01"), "week"), "2026-W53");
  });

  test("late December can belong to the next year's first week", () => {
    // 31 Dec 2029 is a Monday: it opens ISO week 1 of 2030.
    assert.equal(periodKey(nzDay("2029-12-31"), "week"), "2030-W01");
  });

  test("week 1 is the one holding the first Thursday", () => {
    // 4 January is in week 1 by definition, in every year.
    for (const year of [2024, 2025, 2026, 2027, 2028]) {
      assert.equal(periodKey(nzDay(`${year}-01-04`), "week"), `${year}-W01`);
    }
  });

  test("a week's start is its Monday, and its end the next Monday", () => {
    const start = periodStart("2026-W29", "week");
    assert.equal(start.toISOString(), "2026-07-13T00:00:00.000Z");
    assert.equal(start.getUTCDay(), 1, "Monday");
    assert.equal(periodEnd("2026-W29", "week").toISOString(), "2026-07-20T00:00:00.000Z");
  });
});

describe("the tax year", () => {
  test("runs 1 April to 31 March and is named for the year it ends in", () => {
    assert.equal(periodKey(nzDay("2026-04-01"), "taxyear"), "FY2027");
    assert.equal(periodKey(nzDay("2027-03-31"), "taxyear"), "FY2027");
    // A day either side is a different tax year.
    assert.equal(periodKey(nzDay("2026-03-31"), "taxyear"), "FY2026");
    assert.equal(periodKey(nzDay("2027-04-01"), "taxyear"), "FY2028");
  });

  test("its span opens on 1 April of the year before its name", () => {
    assert.equal(periodStart("FY2027", "taxyear").toISOString(), "2026-04-01T00:00:00.000Z");
    assert.equal(periodEnd("FY2027", "taxyear").toISOString(), "2027-04-01T00:00:00.000Z");
  });

  test("the key carries the full ending year so it sorts with the rest", () => {
    assert.ok("FY2027" < "FY2028");
    // The abbreviated label is only for display.
    assert.equal(formatPeriodShort("FY2027", "taxyear"), "FY27");
    assert.equal(formatPeriodKey("FY2027", "taxyear"), "FY27 (Apr 2026 – Mar 2027)");
  });
});

describe("periodWindow", () => {
  const now = nzDay("2026-07-14");

  test("is `count` keys, oldest first, ending on the period in progress", () => {
    assert.deepEqual(periodWindow(now, "month", 6), [
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
    ]);
  });

  test("an offset pages further back, and the windows abut without a gap", () => {
    const current = periodWindow(now, "month", 6, 0);
    const previous = periodWindow(now, "month", 6, 6);
    assert.equal(previous.length, 6);
    assert.deepEqual(previous, ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01"]);
    assert.equal(previous[previous.length - 1], "2026-01");
    assert.equal(current[0], "2026-02");
  });

  test("stepping back over a year boundary rolls the year, not the month", () => {
    assert.deepEqual(periodWindow(nzDay("2026-02-10"), "month", 4), [
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  test("quarters step three months at a time, snapped to the quarter's start", () => {
    assert.deepEqual(periodWindow(now, "quarter", 4), ["2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3"]);
  });

  test("every window is distinct keys — a step that lands twice would double a total", () => {
    for (const period of PERIODS) {
      const keys = periodWindow(now, period, 8);
      assert.equal(new Set(keys).size, keys.length, `${period} repeats a key`);
    }
  });
});

describe("offsetForStartDate", () => {
  const now = nzDay("2026-07-14");

  test("a date in the current window is offset 0", () => {
    // The 6-month window ending July 2026 opens at February.
    assert.equal(offsetForStartDate(now, "month", 6, nzDay("2026-02-10")), 0);
  });

  test("round-trips: the offset it returns opens a window at that period", () => {
    for (const period of PERIODS) {
      for (const offset of [0, 1, 3, 7]) {
        const window = periodWindow(now, period, 6, offset);
        const start = periodStart(window[0], period);
        assert.equal(
          offsetForStartDate(now, period, 6, start),
          offset,
          `${period} at offset ${offset} did not round-trip`,
        );
      }
    }
  });

  test("a far-future date snaps to the current window rather than looping", () => {
    assert.equal(offsetForStartDate(now, "month", 6, nzDay("2099-01-01")), 0);
  });
});

describe("periodStart and periodEnd", () => {
  test("the end of a period is the start of the next one", () => {
    const cases: [Period, string, string][] = [
      ["day", "2026-07-14", "2026-07-15"],
      ["month", "2026-01", "2026-02"],
      ["month", "2026-12", "2027-01"],
      ["quarter", "2026-Q4", "2027-Q1"],
      ["year", "2026", "2027"],
    ];
    for (const [period, key, next] of cases) {
      assert.equal(
        periodEnd(key, period).getTime(),
        periodStart(next, period).getTime(),
        `${period} ${key} does not end where ${next} begins`,
      );
    }
  });

  test("February's length is found, not assumed", () => {
    // The `skip`-then-snap trick has to survive the shortest month and a leap year.
    assert.equal(periodEnd("2026-02", "month").toISOString(), "2026-03-01T00:00:00.000Z");
    assert.equal(periodEnd("2028-02", "month").toISOString(), "2028-03-01T00:00:00.000Z");
    assert.equal(periodStart("2028-02", "month").toISOString(), "2028-02-01T00:00:00.000Z");
  });

  test("a key's own start falls back inside that key, for every period", () => {
    // The property that ties the two directions together: bucket a period's first
    // instant and you must get the period back. Nudged an hour past the boundary
    // rather than sat exactly on it, so the property is not passing by landing on
    // a knife edge — but only an hour: `periodStart` is UTC midnight and the
    // bucketing resolves in NZ time, so half a day would step into the next date.
    for (const period of PERIODS) {
      for (const key of periodWindow(nzDay("2026-07-14"), period, 8)) {
        const start = periodStart(key, period);
        const inside = new Date(start.getTime() + 60 * 60 * 1000);
        assert.equal(periodKey(inside, period), key, `${period} ${key} did not round-trip`);
      }
    }
  });
});

describe("fetchCutoff", () => {
  test("reaches back past the window it is fetching for", () => {
    const now = nzDay("2026-07-14");
    for (const period of PERIODS) {
      const oldest = periodStart(periodWindow(now, period, 6)[0], period);
      assert.ok(
        fetchCutoff(now, period, 6) <= oldest,
        `${period}: the cutoff would miss the window's own first period`,
      );
    }
  });
});

describe("isPeriod", () => {
  test("accepts every period and nothing else", () => {
    for (const period of PERIODS) assert.equal(isPeriod(period), true);
    assert.equal(isPeriod("fortnight"), false);
    assert.equal(isPeriod("Month"), false, "case-sensitive: it is a url segment");
    assert.equal(isPeriod(""), false);
  });
});

describe("formatting", () => {
  test("a week is named by its Monday's date, not its ordinal", () => {
    assert.equal(formatPeriodKey("2026-W29", "week"), "Week of 13 Jul 2026");
    assert.equal(formatPeriodShort("2026-W29", "week"), "13 Jul");
  });

  test("a quarter's short form carries a two-digit year, a month's does not", () => {
    // Six quarters span more than one year, so `Q1 Q2 Q3 Q4 Q1 Q2` would name two
    // different quarters the same thing; six months are unique within a window.
    assert.equal(formatPeriodShort("2026-Q3", "quarter"), "Q3 '26");
    assert.equal(formatPeriodShort("2026-07", "month"), "Jul");
    assert.equal(formatPeriodKey("2026-07", "month"), "Jul 2026");
    assert.equal(formatPeriodKey("2026-Q3", "quarter"), "Q3 2026");
  });

  test("every period formats to something non-empty", () => {
    const now = nzDay("2026-07-14");
    for (const period of PERIODS) {
      for (const key of periodWindow(now, period, 3)) {
        assert.ok(formatPeriodKey(key, period).length > 0, `${period} ${key} long form`);
        assert.ok(formatPeriodShort(key, period).length > 0, `${period} ${key} short form`);
      }
    }
  });
});
