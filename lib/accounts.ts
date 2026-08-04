// How far an account can be spent down.
//
// Pure arithmetic over the three balance figures a provider gives us, kept out of
// `lib/server/metrics/balance.ts` so the one genuinely subtle rule in it — which
// limits are credit you may draw, and which are just the size of a debt — can be
// checked directly against the shapes real banks report.

/** The balance columns these rules read, in the display-agnostic form
 *  `accountMoney` produces: plain numbers, still in the account's own currency. */
export type BalanceFacts = {
  balanceCurrent: number | null;
  balanceAvailable: number | null;
  balanceLimit: number | null;
};

/**
 * Credit still drawable on this account, as a positive figure. Zero for plain
 * money, and zero for a debt with nothing left to redraw.
 *
 * The test is the provider's own `available` rather than the account type, which
 * is what makes the answer right for the account this matters most for. Akahu
 * reports a revolving home-loan facility as a `LOAN`: $3,650 of its own money
 * against a $30,000 limit, and $33,650 available. `available` is everything
 * spendable from the account — its own money and its undrawn credit together —
 * so the credit half is what it exceeds the balance by.
 *
 * A term loan is kept out by the same rule rather than by a special case. A
 * half-repaid mortgage reports nothing available, so it offers no headroom:
 * repaying a term loan does not hand the money back, and a limit that is really
 * the principal it was written for is not an invitation to spend it again. Where
 * a loan genuinely does have redraw, the provider says so in `available` and it
 * counts — which is the honest answer, not an exception to this one.
 */
export function drawableCredit(account: BalanceFacts): number {
  const spendable = spendableFrom(account);
  if (spendable === null) return 0;
  // Only the part that is borrowed: money of your own sitting in the account is
  // spendable too, and counting it as credit would report a $10,000 card holding
  // $200 as offering $10,200 of borrowing.
  return round2(Math.max(0, spendable - Math.max(0, account.balanceCurrent ?? 0)));
}

/**
 * The lowest balance this account can be run down to.
 *
 * Zero for plain money: an account with no facility stops when it is empty, and
 * its `available` is a statement about pending holds rather than about how far it
 * can be spent, so a hold must not lift the floor above zero. A facility bottoms
 * out at minus whatever it can still draw, below wherever it sits today. A debt
 * with no redraw simply stays where it is — repaying it moves money between
 * accounts rather than making any.
 */
export function spendFloor(account: BalanceFacts): number {
  const current = account.balanceCurrent ?? 0;
  const spendable = spendableFrom(account);
  // Spending everything available lands the balance exactly `available` lower.
  // Not `current - drawableCredit`: the part of a facility already drawn is
  // inside `current`, so subtracting only the *undrawn* half would put the floor
  // above the limit by however much has been spent already.
  return round2(Math.min(0, spendable === null ? current : current - spendable));
}

/**
 * How much money can be spent out of this account, according to the provider —
 * or null where the account carries no facility and the question is just "how
 * much is in it".
 *
 * `available` is only read where there is a limit to make sense of it. On an
 * everyday account the gap between current and available is a pending hold, and
 * treating that as a floor would stop a projection a few dollars short of empty
 * for reasons no reader could see.
 */
function spendableFrom(account: BalanceFacts): number | null {
  const { balanceAvailable, balanceLimit } = account;
  if (balanceLimit === null || balanceLimit <= 0 || balanceAvailable === null) return null;

  // Spending it all draws exactly the limit, so that is the cap no matter how
  // generous a provider's `available` looks.
  const cap = (account.balanceCurrent ?? 0) + balanceLimit;
  return Math.max(0, Math.min(balanceAvailable, cap));
}

/** Whole cents. These are differences of two provider figures, and a floor of
 *  −29,999.999999999996 is a rounding artefact, not a credit limit. */
const round2 = (value: number) => Math.round(value * 100) / 100;
