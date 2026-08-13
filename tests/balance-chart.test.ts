import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  brushDomain,
  brushSpan,
  brushTicks,
  clampWindow,
  compactMoney,
  matchPreset,
  MIN_SELECTION_PX,
  MIN_TICK_PX,
  MIN_WINDOW_DAYS,
  niceScale,
  presetWindow,
  RANGES,
  rangeDays,
  tickStep,
  type Window,
  worthAt,
} from "../ui/dashboard/balance-chart.util";

/**
 * The maths behind the balance chart's time window — the part the overview
 * strip drags and the range buttons jump, and the only part of the chart that
 * can be tested without a browser.
 */

// A domain long enough that every range button fits inside it without clamping,
// so the presets stay distinguishable: ~3.3 years of history, ~2 years ahead.
const N = 1200;
const TOTAL = 1930;

describe("clampWindow", () => {
  test("leaves a window that already fits alone", () => {
    assert.deepEqual(clampWindow({ start: 10, end: 40 }, 100), { start: 10, end: 40 });
  });

  test("widens a window dragged below the minimum", () => {
    assert.deepEqual(clampWindow({ start: 10, end: 11 }, 100), {
      start: 10,
      end: 10 + MIN_WINDOW_DAYS,
    });
  });

  test("orders reversed edges, so a backwards drag still selects a span", () => {
    assert.deepEqual(clampWindow({ start: 40, end: 10 }, 100), { start: 10, end: 40 });
  });

  test("slides a window past an edge back inside with its width intact", () => {
    // A pan that hits the end of the data must not silently zoom in.
    assert.deepEqual(clampWindow({ start: 90, end: 120 }, 100), { start: 70, end: 100 });
    assert.deepEqual(clampWindow({ start: -20, end: 10 }, 100), { start: 0, end: 30 });
  });

  test("shows a domain shorter than the minimum window whole", () => {
    // A workspace three days old: there is nothing to zoom into, and the window
    // must not come back with start past end.
    const win = clampWindow({ start: 0, end: 1 }, 3);
    assert.deepEqual(win, { start: 0, end: 3 });
    assert.ok(win.start < win.end);
  });
});

describe("presetWindow", () => {
  test("fits the whole domain for Max", () => {
    assert.deepEqual(presetWindow(null, N, TOTAL), { start: 0, end: TOTAL });
  });

  test("centres the span on today", () => {
    assert.deepEqual(presetWindow(30, N, TOTAL), { start: N - 15, end: N + 15 });
  });

  test("clamps when today sits near the start of the domain", () => {
    // A fresh workspace: a 30-day window cannot be centred on day 3, but it is
    // still 30 days wide.
    const win = presetWindow(30, 3, 100);
    assert.deepEqual(win, { start: 0, end: 30 });
  });

  test("gives every range button the span it names", () => {
    // The minimum window must not quietly widen the tightest button: a "1W" that
    // drew a fortnight would be a button lying about what it did.
    for (const range of RANGES) {
      const win = presetWindow(rangeDays(range.key), N, TOTAL);
      assert.equal(win.end - win.start, rangeDays(range.key) ?? TOTAL, range.key);
    }
  });

  test("never asks for more days than the domain has", () => {
    assert.deepEqual(presetWindow(5000, N, TOTAL), { start: 0, end: TOTAL });
  });
});

describe("matchPreset", () => {
  test("round-trips every range button", () => {
    for (const range of RANGES) {
      const win = presetWindow(rangeDays(range.key), N, TOTAL);
      assert.equal(matchPreset(win, N, TOTAL), range.key, range.key);
    }
  });

  test("is null for a hand-dragged window", () => {
    assert.equal(matchPreset({ start: 100, end: 437 }, N, TOTAL), null);
  });

  test("is null once a preset has been nudged off", () => {
    const win = presetWindow(30, N, TOTAL);
    assert.equal(matchPreset({ start: win.start - 4, end: win.end }, N, TOTAL), null);
  });
});

describe("brushSpan", () => {
  // The strip as the plot sees it on a laptop card and on a phone.
  const WIDE = 900;
  const NARROW = 300;

  const selectionPx = (winSpan: number, width: number) =>
    (winSpan / brushSpan(winSpan, width, TOTAL)) * width;

  test("keeps the selection grabbable at every range button, at any width", () => {
    for (const range of RANGES) {
      const win = presetWindow(rangeDays(range.key), N, TOTAL);
      for (const width of [WIDE, NARROW, 120]) {
        const px = selectionPx(win.end - win.start, width);
        assert.ok(px >= MIN_SELECTION_PX - 0.001, `${range.key} at ${width}px drew ${px}px`);
      }
    }
  });

  test("shows context around the window when there is room for it", () => {
    // A month on a wide strip is not blown up to fill it: the point of the strip
    // is the ground around the window.
    assert.ok(brushSpan(30, WIDE, TOTAL) > 30 * 3);
  });

  test("never asks for more than the domain, nor less than the window", () => {
    assert.equal(brushSpan(TOTAL, WIDE, TOTAL), TOTAL);
    assert.ok(brushSpan(1200, WIDE, TOTAL) <= TOTAL);
    assert.ok(brushSpan(1200, WIDE, TOTAL) >= 1200);
  });
});

describe("brushDomain", () => {
  const WIDTH = 900;
  const frame = (win: Window, prev: Window | null, settled: boolean) =>
    brushDomain(win, prev, TOTAL, WIDTH, settled);
  const contains = (outer: Window, inner: Window) =>
    outer.start <= inner.start + 1e-6 && outer.end >= inner.end - 1e-6;

  test("frames a window it has no previous frame for", () => {
    const win = { start: 600, end: 630 };
    const out = frame(win, null, true);
    assert.ok(contains(out, win));
    // Centred on the window, so there is as much to drag into either way.
    assert.ok(Math.abs((out.start + out.end) / 2 - 615) < 1e-6);
  });

  test("stays inside the domain at either end", () => {
    for (const win of [{ start: 0, end: 30 }, { start: TOTAL - 30, end: TOTAL }]) {
      const out = frame(win, null, true);
      assert.ok(out.start >= 0);
      assert.ok(out.end <= TOTAL);
      assert.ok(contains(out, win));
    }
  });

  test("holds still under a drag that stays inside it", () => {
    // The frame must not rescale under a moving handle: the data would slide out
    // from under the pointer and the gesture would chase itself.
    const prev = frame({ start: 600, end: 630 }, null, true);
    assert.deepEqual(frame({ start: 610, end: 640 }, prev, false), prev);
    assert.deepEqual(frame({ start: 600, end: 660 }, prev, false), prev);
  });

  test("slides by the least that keeps a panned window inside", () => {
    const prev = { start: 500, end: 700 };
    const out = frame({ start: 690, end: 720 }, prev, false);
    assert.equal(out.end - out.start, 200);
    assert.equal(out.end, 720);
    assert.ok(contains(out, { start: 690, end: 720 }));
  });

  test("re-frames once a settled window no longer suits the frame", () => {
    // Zooming from the whole domain to a month leaves the old frame drawing a
    // sliver; settling is where that gets rebuilt.
    const prev = { start: 0, end: TOTAL };
    const win = { start: 600, end: 630 };
    const out = frame(win, prev, true);
    assert.ok(out.end - out.start < TOTAL / 2);
    assert.ok(contains(out, win));
  });

  test("keeps the frame across a pan that only moved the window", () => {
    const prev = frame({ start: 600, end: 630 }, null, true);
    const out = frame({ start: 605, end: 635 }, prev, true);
    assert.equal(out.start, prev.start);
    assert.equal(out.end, prev.end);
  });

  test("never rescales mid-drag, however far a handle is pulled in", () => {
    // The pointer already has hold of the handle; rescaling to keep the
    // selection grabbable would move the strip under it for no gain. The frame
    // that catches up is the settled one, on release.
    const prev = { start: 0, end: TOTAL };
    const win = { start: 600, end: 614 };
    assert.deepEqual(frame(win, prev, false), prev);
    assert.ok(frame(win, prev, true).end - frame(win, prev, true).start < TOTAL);
  });

  test("widens just enough for a window dragged past its edges", () => {
    // The window can outgrow the frame in one drag; the frame follows it rather
    // than letting the selection hang off the end of the strip.
    const prev = { start: 600, end: 700 };
    const out = frame({ start: 500, end: 800 }, prev, false);
    assert.deepEqual(out, { start: 500, end: 800 });
  });

  test("keeps every settled frame grabbable", () => {
    for (const range of RANGES) {
      const win = presetWindow(rangeDays(range.key), N, TOTAL);
      for (const width of [WIDTH, 300, 120]) {
        // Whatever frame the strip was in before, settling leaves one the
        // selection can be taken hold of in.
        for (const prev of [null, { start: 0, end: TOTAL }, { start: 1100, end: 1130 }]) {
          const out = brushDomain(win, prev, TOTAL, width, true);
          const px = ((win.end - win.start) / (out.end - out.start)) * width;
          assert.ok(px >= MIN_SELECTION_PX - 0.01, `${range.key} at ${width}px drew ${px}px`);
        }
      }
    }
  });

  test("settles on a frame it will not then move again", () => {
    for (const win of [
      { start: 600, end: 630 },
      { start: 0, end: TOTAL },
      { start: TOTAL - 14, end: TOTAL },
    ]) {
      const once = frame(win, null, true);
      assert.deepEqual(frame(win, once, true), once);
      assert.deepEqual(frame(win, once, false), once);
    }
  });
});

describe("brushTicks", () => {
  const WIDTH = 900;
  const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  // Day 0 of the domain, so the frame's dates are the ones a reader would check
  // the labels against.
  const DAY0 = Date.UTC(2021, 0, 1);
  const dateAt = (unit: number) => new Date(DAY0 + Math.round(unit) * 86_400_000);
  const label = {
    month: (d: Date) => MONTHS[d.getUTCMonth()],
    day: (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`,
  };
  const ticksFor = (rangeKey: string, width = WIDTH) => {
    const win = presetWindow(rangeDays(rangeKey), N, TOTAL);
    const frame = brushDomain(win, null, TOTAL, width, true);
    const dpx = width / (frame.end - frame.start);
    return { frame, dpx, ticks: brushTicks(frame, width, dateAt, label) };
  };

  test("steps by what the frame has room for", () => {
    // The zoom the strip is at, not the one the window is at: a week's window
    // is framed in weeks, and the whole domain in years.
    assert.equal(ticksFor("1W").ticks.length > 0, true);
    assert.equal(tickStep(WIDTH / (ticksFor("1W").frame.end - ticksFor("1W").frame.start)), "week");
    assert.equal(tickStep(WIDTH / (ticksFor("1M").frame.end - ticksFor("1M").frame.start)), "month");
    assert.equal(tickStep(WIDTH / (ticksFor("Max").frame.end - ticksFor("Max").frame.start)), "year");
  });

  test("names a year for itself, and a month for itself", () => {
    const { ticks } = ticksFor("1M");
    const first = ticks.find((t) => t.rank > 0);
    assert.ok(first);
    // Every mark on a first-of-the-month reads as a month or a year, never as a
    // bare day number.
    for (const t of ticks) {
      if (t.rank === 2) assert.match(t.text, /^\d{4}$/);
      if (t.rank === 1) assert.ok(MONTHS.includes(t.text), t.text);
      if (t.rank === 0) assert.match(t.text, /^\d{1,2} [A-Z][a-z]{2}$/);
    }
  });

  test("marks every month of a month-stepped frame", () => {
    const { frame, ticks } = ticksFor("1M");
    const months = ticks.filter((t) => t.rank > 0).length;
    // A 180-day frame holds six month starts; none of them is dropped.
    assert.ok(months >= Math.floor((frame.end - frame.start) / 31), `${months} months`);
  });

  test("drops the smaller unit when the band gets crowded", () => {
    // The whole domain cannot show months — sixty of them in 900px — so only the
    // years are left standing.
    const { ticks } = ticksFor("Max");
    assert.ok(ticks.length > 0);
    for (const t of ticks) assert.equal(t.rank, 2, t.text);
  });

  test("never draws two labels on top of each other", () => {
    for (const range of RANGES) {
      for (const width of [WIDTH, 300, 120]) {
        const { dpx, ticks } = ticksFor(range.key, width);
        for (let i = 1; i < ticks.length; i++) {
          const gap = (ticks[i].unit - ticks[i - 1].unit) * dpx;
          assert.ok(gap >= MIN_TICK_PX * 0.7 - 1e-6, `${range.key} at ${width}px: ${gap}px apart`);
        }
      }
    }
  });

  test("keeps a week frame to its own rhythm, on Mondays", () => {
    // Every mark is a week start and reads as a date. A month cut in among them
    // would be the one label not answering the question its neighbours answer —
    // and the month is in each of those labels already.
    const { ticks } = ticksFor("1W");
    assert.ok(ticks.length >= 4);
    for (const t of ticks) {
      assert.equal(dateAt(t.unit).getUTCDay(), 1, t.text);
      assert.match(t.text, /^\d{1,2} [A-Z][a-z]{2}( '\d{2})?$/);
    }
  });

  test("names the year the first time a dated band enters one", () => {
    // Six weeks either side of a New Year, which the day labels alone would not
    // place: the plot's axis marks a January the same way.
    const frame = { start: 320, end: 410 }; // 2021-11-17 → 2022-02-14
    const ticks = brushTicks(frame, WIDTH, dateAt, label);
    const dated = ticks.filter((t) => t.text.includes("'"));
    assert.equal(dated.length, 1);
    assert.match(dated[0].text, / '22$/);
    assert.equal(dateAt(dated[0].unit).getUTCFullYear(), 2022);
    // And it is the first mark of that year, not just any of them.
    const before = ticks[ticks.indexOf(dated[0]) - 1];
    assert.equal(dateAt(before.unit).getUTCFullYear(), 2021);
  });

  test("stays inside the frame, in order", () => {
    for (const range of RANGES) {
      const { frame, ticks } = ticksFor(range.key);
      for (const t of ticks) {
        assert.ok(t.unit >= frame.start && t.unit <= frame.end, `${range.key}: ${t.text}`);
      }
      for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].unit > ticks[i - 1].unit);
    }
  });

  test("degrades to the single day of a frame with no width", () => {
    // Not a frame `brushDomain` can produce, but the loops here walk a calendar
    // and must terminate on one rather than running the length of the domain.
    const ticks = brushTicks({ start: 5, end: 5 }, WIDTH, dateAt, label);
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].unit, 5);
  });
});

describe("worthAt", () => {
  const points = [
    { day: 10, worth: 900 },
    { day: 20, worth: 800 },
  ];

  test("interpolates along the segment the renderer draws", () => {
    assert.equal(worthAt(points, 0, 1000), 1000);
    assert.equal(worthAt(points, 5, 1000), 950);
    assert.equal(worthAt(points, 10, 1000), 900);
    assert.equal(worthAt(points, 15, 1000), 850);
    assert.equal(worthAt(points, 20, 1000), 800);
  });

  test("reports nothing past the line's own end", () => {
    // A projection that has run out has no worth; continuing it flat would claim
    // the balance stops falling exactly when the plan stops describing it.
    assert.equal(worthAt(points, 21, 1000), null);
    assert.equal(worthAt(points, -1, 1000), null);
    assert.equal(worthAt([], 0, 1000), null);
  });
});

describe("niceScale", () => {
  test("covers the range on round steps", () => {
    const scale = niceScale(0, 100);
    assert.ok(scale.min <= 0);
    assert.ok(scale.max >= 100);
    assert.equal(scale.ticks[0], scale.min);
    assert.equal(scale.ticks[scale.ticks.length - 1], scale.max);
  });

  test("covers a range that straddles zero", () => {
    const scale = niceScale(-500, 1500);
    assert.ok(scale.min <= -500);
    assert.ok(scale.max >= 1500);
    assert.ok(scale.ticks.includes(0));
  });

  test("survives a flat series", () => {
    const scale = niceScale(42, 42);
    assert.ok(scale.max > scale.min);
    assert.ok(scale.ticks.length > 1);
  });
});

describe("compactMoney", () => {
  test("scales to the axis's shorthand", () => {
    assert.equal(compactMoney(850, "NZD"), "$850");
    assert.equal(compactMoney(40_000, "NZD"), "$40K");
    assert.equal(compactMoney(1_200_000, "NZD"), "$1.2M");
  });

  test("spends a decimal only where it says something", () => {
    // $1.2M earns one; $40K does not, and neither does a round $2M.
    assert.equal(compactMoney(2_000_000, "NZD"), "$2M");
    assert.equal(compactMoney(45_600, "NZD"), "$46K");
  });

  test("keeps the sign", () => {
    assert.equal(compactMoney(-1_200_000, "NZD"), "-$1.2M");
  });
});
