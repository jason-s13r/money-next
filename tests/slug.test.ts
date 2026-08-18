import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assertSlug, chooseSlug, slugBase, slugify, suggestName } from "../cli/lib/slug";

/**
 * The rules that turn a workspace's name into its URL.
 *
 * Worth testing rather than eyeballing because there is no rename: whatever slug
 * a workspace is given at creation, it keeps. A derivation bug is not a bug you
 * fix, it is a URL somebody has bookmarked.
 */

describe("suggestName", () => {
  test("is the owner's first name, possessive", () => {
    assert.equal(suggestName("Sam Rivera"), "Sam's Personal");
  });

  test("copes with a single-word name", () => {
    assert.equal(suggestName("Prince"), "Prince's Personal");
  });

  test("copes with extra whitespace", () => {
    assert.equal(suggestName("  Sam   Rivera "), "Sam's Personal");
  });
});

describe("slugify", () => {
  // The case this module exists for. Both of the obvious implementations get it
  // wrong: replacing punctuation with the separator gives `sam-s-personal`,
  // and deleting the apostrophe alone gives `sams-personal`.
  test("drops a possessive rather than transliterating it", () => {
    assert.equal(slugify("Sam's Personal"), "sam-personal");
  });

  test("handles the typographic apostrophe the same way", () => {
    assert.equal(slugify("Sam’s Personal"), "sam-personal");
  });

  test("keeps a non-possessive apostrophe as one word", () => {
    assert.equal(slugify("O'Brien Family"), "obrien-family");
  });

  test("collapses punctuation and trims the edges", () => {
    assert.equal(slugify("  The Flat (2026)!  "), "the-flat-2026");
  });

  test("plain names pass through", () => {
    assert.equal(slugify("Personal"), "personal");
  });
});

describe("slugBase", () => {
  test("uses the name when it has anything usable", () => {
    assert.equal(slugBase("The Flat", "Sam Rivera"), "the-flat");
  });

  test("falls back to the owner when the name is all punctuation", () => {
    assert.equal(slugBase("...", "Sam Rivera"), "sam-personal");
  });

  // 日本語 is Japanese for "the Japanese language" — used here because it is
  // three characters with no Latin letters at all, so `slugify` returns "".
  test("falls back to the owner for a non-Latin name", () => {
    assert.equal(slugBase("日本語", "Sam Rivera"), "sam-personal");
  });

  // The property the fallback rests on: `suggestName` ends in the literal
  // "Personal", so the second rung survives an owner whose name is also
  // unslugifiable. If this ever fails, `slugBase` needs a third rung — and the
  // point of asserting it is that nobody has to guess whether it does.
  //
  // 山田太郎 (Yamada Tarō) is the standard Japanese placeholder name, the
  // equivalent of "John Doe" — an ordinary name that happens to slugify to
  // nothing, which is the case being covered.
  test("is never empty, even when both the name and the owner are non-Latin", () => {
    assert.equal(slugBase("日本語", "山田太郎"), "personal");
    assert.doesNotThrow(() => assertSlug(slugBase("日本語", "山田太郎")));
  });
});

describe("assertSlug", () => {
  test("accepts what slugify produces", () => {
    for (const name of ["Personal", "Sam's Personal", "The Flat (2026)"]) {
      assert.doesNotThrow(() => assertSlug(slugify(name)));
    }
  });

  test("rejects edge hyphens, uppercase, underscores and empty", () => {
    for (const bad of ["-personal", "personal-", "", "Personal", "a_b", "a b"]) {
      assert.throws(() => assertSlug(bad), /not usable as a URL segment/);
    }
  });

  // Ugly, legal, and only reachable via an explicit `--slug`: `slugify`
  // collapses runs, so nothing derived can produce one. Not worth a rule — the
  // check is "is this a usable URL segment", not "is this pretty".
  test("permits doubled hyphens in the middle", () => {
    assert.doesNotThrow(() => assertSlug("a--b"));
  });
});

describe("chooseSlug", () => {
  test("uses the plain slug when it is free", async () => {
    assert.equal(await chooseSlug("personal", async () => false), "personal");
  });

  test("suffixes when taken, and the suffix is four hex characters", async () => {
    const chosen = await chooseSlug("personal", async (s) => s === "personal");
    assert.match(chosen, /^personal-[0-9a-f]{4}$/);
    // Still a legal URL segment — the suffix must not undo the validation.
    assert.doesNotThrow(() => assertSlug(chosen));
  });

  // The branch that would otherwise never run. It needs ~65k same-named
  // workspaces in reality, which is exactly why it is driven from a predicate
  // here instead of being left as an untested `else`.
  test("keeps trying while suffixed candidates are also taken", async () => {
    const seen: string[] = [];
    const chosen = await chooseSlug("personal", async (s) => {
      seen.push(s);
      return seen.length <= 3; // plain + two suffixed are taken.
    });

    assert.equal(seen.length, 4);
    assert.match(chosen, /^personal-[0-9a-f]{4}$/);
  });

  test("gives up rather than looping forever, and says what to do", async () => {
    await assert.rejects(
      () => chooseSlug("personal", async () => true, 3),
      /Could not find a free slug for "personal" after 3 attempts[\s\S]*--slug/,
    );
  });
});
