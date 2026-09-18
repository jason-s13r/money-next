import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  dismissalFor,
  dismissalTokens,
  matchesDismissal,
  type DismissalRule,
} from "../lib/server/pending-dismissal";

/**
 * Dismissed pending holds: what a rule derived from one hold goes on to cover.
 *
 * The whole feature rests on that reach being right in both directions, and
 * neither direction is visible from the listing. Too narrow and the Wise cashback
 * a person dismissed is back tomorrow under a new id, which is the thing they
 * asked to be rid of. Too wide and holds they have never seen are hidden by a
 * rule they taught from something else — silently, since a dismissed row shows
 * only when the listing is expanded.
 */

const WISE = "conn_wise";
const OTHER = "conn_other";

function rule(tokens: string[], connectionId = WISE): DismissalRule {
  return { id: `dismissal_${tokens.join("-")}`, connectionId, tokens };
}

describe("deriving a dismissal from a hold", () => {
  test("keeps the identifying word of a one-word description", () => {
    assert.deepEqual(dismissalTokens("Cashback"), ["cashback"]);
  });

  test("drops the receipt number that would make the rule match once", () => {
    // The number is the whole problem: it is different on the next McDonald's
    // hold, so a rule carrying it would hide this row and nothing after it.
    const tokens = dismissalTokens("#759255 MCDONALDS BANK STREET WHANGAREI NZ");
    assert.ok(!tokens.some((t) => t.includes("759255")), `kept the receipt number: ${tokens}`);
    assert.ok(tokens.includes("mcdonalds"));

    assert.ok(
      matchesDismissal(
        rule(tokens),
        { connectionId: WISE, description: "#755187 MCDONALDS BANK STREET WHANGAREI NZ" },
      ),
      "the next hold from the same shop was not covered",
    );
  });

  test("falls back to the whole description when nothing distinctive is left", () => {
    // An all-numeric description tokenises to nothing worth keying on. The rule
    // becomes literal rather than bank-wide: hiding this exact wording is a small
    // promise, hiding everything from the bank is not the one that was made.
    assert.deepEqual(dismissalTokens("0800 123456"), ["0800 123456"]);
  });

  test("an empty description yields no rule at all", () => {
    // What stops `dismissPending` writing a rule that matches every hold at the
    // bank — the empty token list is the signal, so it has to stay empty.
    assert.deepEqual(dismissalTokens("   "), []);
  });
});

describe("what a dismissal hides", () => {
  test("every token must appear, not just one", () => {
    const twoWords = rule(["annual", "fee"]);
    assert.ok(matchesDismissal(twoWords, { connectionId: WISE, description: "Annual fee" }));
    assert.ok(!matchesDismissal(twoWords, { connectionId: WISE, description: "Monthly fee" }));
  });

  test("case is not part of the match", () => {
    // Akahu shouts some descriptions and title-cases others; the same hold must
    // not escape a dismissal by arriving in different case.
    assert.ok(matchesDismissal(rule(["cashback"]), { connectionId: WISE, description: "CASHBACK" }));
  });

  test("another bank's identical description is untouched", () => {
    // The scope that makes "Wise cashback" mean Wise. A bank the person never
    // dismissed anything at keeps showing its holds, whatever they are called.
    assert.ok(
      !matchesDismissal(rule(["cashback"]), { connectionId: OTHER, description: "Cashback" }),
    );
  });

  test("a rule with no tokens hides nothing rather than everything", () => {
    // Unwritable through the action, but the failure mode if one ever existed is
    // a whole bank's holds vanishing with no row left to explain it.
    assert.ok(!matchesDismissal(rule([]), { connectionId: WISE, description: "Cashback" }));
  });

  test("a hold names the rule hiding it, so the listing can offer to undo that one", () => {
    const rules = [rule(["mcdonalds"]), rule(["cashback"])];
    const hit = dismissalFor({ connectionId: WISE, description: "Cashback" }, rules);
    assert.equal(hit?.id, "dismissal_cashback");

    assert.equal(dismissalFor({ connectionId: WISE, description: "Countdown" }, rules), null);
  });
});
