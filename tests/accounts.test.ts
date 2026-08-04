import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { drawableCredit, spendFloor } from "../lib/accounts";

/**
 * Which limits are credit you may spend, and which are just the size of a debt.
 *
 * This is the rule the balance chart's forecast is allowed to go negative
 * against, so getting it wrong is not a cosmetic matter: too generous and the
 * projection cheerfully spends a mortgage that was never redrawable, too mean and
 * someone with an overdraft is told their money stops at zero when it does not.
 * The shapes below are the ones real providers report.
 */

describe("drawable credit is what the provider says is available, not the limit", () => {
  test("a revolving facility offers its whole undrawn limit", () => {
    // Akahu's shape for a revolving home loan: its own money in it, a limit
    // behind it, and an `available` that is the two added together. It is typed
    // LOAN, which is exactly why this rule cannot go by account type.
    const revolving = {
      balanceCurrent: 3650.95,
      balanceAvailable: 33_650.95,
      balanceLimit: 30_000,
    };

    assert.equal(drawableCredit(revolving), 30_000);
    assert.equal(spendFloor(revolving), -30_000);
  });

  test("a drawn credit card bottoms out at its limit, not at what is left", () => {
    const card = { balanceCurrent: -400, balanceAvailable: 9600, balanceLimit: 10_000 };

    // $9,600 left to borrow, but the floor is the full $10,000: the $400 already
    // drawn is inside the balance the projection starts from, and stopping at
    // −$9,600 would refuse to spend it twice.
    assert.equal(drawableCredit(card), 9600);
    assert.equal(spendFloor(card), -10_000);
  });

  test("a card in credit can still only draw its limit", () => {
    const card = { balanceCurrent: 200, balanceAvailable: 10_200, balanceLimit: 10_000 };

    assert.equal(spendFloor(card), -10_000);
  });

  test("a half-repaid term loan offers nothing to redraw", () => {
    // The case the user's caution was about. The limit is the principal it was
    // written for, and the $150,000 repaid is not sitting there to be spent
    // again: the provider reports nothing available, and so does this.
    const mortgage = { balanceCurrent: -150_000, balanceAvailable: 0, balanceLimit: 300_000 };

    assert.equal(drawableCredit(mortgage), 0);
    // It still drags the floor down to where it already is — that is not
    // headroom, it is the debt already on the books.
    assert.equal(spendFloor(mortgage), -150_000);
  });

  test("a loan with genuine redraw counts exactly what it offers", () => {
    const flexible = { balanceCurrent: -150_000, balanceAvailable: 20_000, balanceLimit: 300_000 };

    assert.equal(drawableCredit(flexible), 20_000);
    assert.equal(spendFloor(flexible), -170_000);
  });

  test("a limit with no available figure is never assumed to be drawable", () => {
    // Silence is not permission: inventing headroom a provider did not report is
    // the one error that lets a forecast spend money that does not exist.
    const unknown = { balanceCurrent: -400, balanceAvailable: null, balanceLimit: 10_000 };

    assert.equal(drawableCredit(unknown), 0);
    assert.equal(spendFloor(unknown), -400);
  });

  test("a provider's over-generous available is capped at the limit", () => {
    const odd = { balanceCurrent: 0, balanceAvailable: 99_999, balanceLimit: 10_000 };

    assert.equal(drawableCredit(odd), 10_000);
  });
});

describe("plain money stops at empty", () => {
  test("an everyday account has no credit and floors at zero", () => {
    const cash = { balanceCurrent: 771.39, balanceAvailable: 744.05, balanceLimit: null };

    assert.equal(drawableCredit(cash), 0);
    // Not $27.34. The gap between current and available is a pending hold, which
    // says nothing about how far the account can be spent — and a floor above
    // zero would stop every projection short of empty.
    assert.equal(spendFloor(cash), 0);
  });

  test("an account reporting nothing available still floors at zero", () => {
    assert.equal(
      spendFloor({ balanceCurrent: 8.5, balanceAvailable: 0, balanceLimit: null }),
      0,
    );
  });

  test("missing balances are not a hole in the floor", () => {
    assert.equal(spendFloor({ balanceCurrent: null, balanceAvailable: null, balanceLimit: null }), 0);
  });
});
