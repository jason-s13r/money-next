import "server-only";
import { connection } from "next/server";
import { db } from "../db";
import { LIQUID_TYPES, LOCKED_TYPES } from "../../categories";
import { displayConverter, getDisplayCurrency } from "../currency";

// Net worth, split by how reachable it is. Every account is valued in the display
// currency (see lib/currency.ts); a balance has no transaction date, so it converts
// at the currency's latest rate.

export type BalanceSummary = {
  /** The currency every figure here is expressed in — the most common one across
   *  active accounts (see `getDisplayCurrency`). */
  displayCurrency: string;
  /** Spendable today: checking, savings, wallets. Uses available, not current. */
  liquid: number;
  /** KiwiSaver and investments — real, but not reachable for decades. */
  locked: number;
  /** Everything, including locked and any drawn debt, in the display currency. */
  total: number;
  /** Total minus locked. The number that reflects decisions you can make. */
  accessible: number;
  facility: {
    name: string;
    limit: number;
    /** Positive only when the facility is actually drawn down. */
    drawn: number;
    utilisation: number;
  } | null;
  /**
   * Every active balance summed per currency, each in its *own* currency — the
   * display currency included, so the breakdown accounts for the whole of net
   * worth rather than just its foreign part. The totals above fold each of these
   * in at its latest rate (see `getBalanceSummary`); this list explains them.
   */
  byCurrency: { currency: string; total: number }[];
};

export async function getBalanceSummary(): Promise<BalanceSummary> {
  await connection();
  const accounts = await db.account.findMany({ where: { status: "ACTIVE" } });

  // Every account is valued in the display currency. A balance has no transaction
  // date, so it converts at the currency's latest rate — the nearest on or before
  // now, which `displayConverter` resolves when handed today's date.
  const display = await getDisplayCurrency();
  const toDisplay = await displayConverter(display, accounts.map((a) => a.currency));
  const asOf = new Date();
  const inDisplay = (amount: number, currency: string | null) =>
    toDisplay(amount, currency, asOf);

  // Locked accounts report `balanceAvailable` as 0, so they must use `current`.
  const liquid = accounts
    .filter((a) => LIQUID_TYPES.has(a.type))
    .reduce((sum, a) => sum + inDisplay(a.balanceAvailable ?? a.balanceCurrent ?? 0, a.currency), 0);

  const locked = accounts
    .filter((a) => LOCKED_TYPES.has(a.type))
    .reduce((sum, a) => sum + inDisplay(a.balanceCurrent ?? 0, a.currency), 0);

  const total = accounts.reduce((sum, a) => sum + inDisplay(a.balanceCurrent ?? 0, a.currency), 0);

  // The revolving facility reports `balanceCurrent` signed: positive means in
  // credit, negative means drawn against the limit. Summing it into net worth is
  // therefore already correct, and only the negative case is debt. Its limit and
  // drawn amount are shown in the display currency; utilisation is a ratio within
  // one currency, so conversion leaves it unchanged.
  const revolving = accounts.find((a) => a.balanceLimit !== null && a.balanceLimit > 0);
  const drawnRaw = revolving ? Math.max(0, -(revolving.balanceCurrent ?? 0)) : 0;
  const facility = revolving
    ? {
        name: revolving.name,
        limit: inDisplay(revolving.balanceLimit!, revolving.currency),
        drawn: inDisplay(drawnRaw, revolving.currency),
        utilisation: drawnRaw / revolving.balanceLimit!,
      }
    : null;

  // Every currency held, including the display one, so the breakdown sums to net
  // worth rather than only its foreign remainder.
  const totalsByCurrency = new Map<string, number>();
  for (const account of accounts) {
    if (!account.currency) continue;
    totalsByCurrency.set(
      account.currency,
      (totalsByCurrency.get(account.currency) ?? 0) + (account.balanceCurrent ?? 0),
    );
  }

  return {
    displayCurrency: display,
    liquid,
    locked,
    total,
    accessible: total - locked,
    facility,
    byCurrency: [...totalsByCurrency]
      .map(([currency, total]) => ({ currency, total }))
      .toSorted((a, b) => b.total - a.total),
  };
}
