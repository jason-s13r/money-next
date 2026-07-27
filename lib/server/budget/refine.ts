import "server-only";
import { connection } from "next/server";

import { getDb } from "../db/request";
import { displayConverter, getDisplayCurrency } from "../currency";
import { money } from "../money";
import { REFINE_MONTHS, refinedAmount } from "../../budget/refine";
import type { Frequency } from "../../budget/recurrence";

// The server half of refining a budget toward actuals: gather the matching
// transactions, convert them, and hand the pure arithmetic (lib/budget/refine.ts)
// what it needs to blend each item's figure halfway to reality.
//
// It reads the same transactions the seeder does — transfers aside, every category
// and type in scope, same per-day FX — and matches each budget item to the ones sharing
// its identity (group, category, merchant), the very key `infer.ts` grouped streams
// by. An item the transactions do not speak to is left exactly as it was.

/** One item's figure that would change, and to what. */
export type Refinement = { id: string; from: number; to: number };

const DAYS = REFINE_MONTHS * 30.44;

const streamKey = (row: {
  categoryGroupId: string | null;
  categoryId: string | null;
  merchantId: string | null;
}) => `${row.categoryGroupId ?? ""}|${row.categoryId ?? ""}|${row.merchantId ?? ""}`;

/**
 * The figures that would move if this budget were refined against the last
 * {@link REFINE_MONTHS} months, and to what. Reads only; the caller decides whether
 * to write them.
 */
export async function computeRefinements(
  budgetId: string,
  now: Date = new Date(),
): Promise<Refinement[]> {
  await connection();
  const db = await getDb();

  const budget = await db.budget.findUnique({
    where: { id: budgetId },
    select: {
      items: {
        select: {
          id: true,
          amount: true,
          categoryGroupId: true,
          categoryId: true,
          merchantId: true,
          frequency: true,
          interval: true,
        },
      },
    },
  });
  if (!budget || budget.items.length === 0) return [];

  const cutoff = new Date(now.getTime() - DAYS * 86_400_000);
  const rows = await db.transaction.findMany({
    where: {
      date: { gte: cutoff },
      type: { notIn: ["TRANSFER"] },
      transferGroupId: null,
      categoryGroupId: { not: null },
    },
    select: {
      date: true,
      amount: true,
      categoryGroupId: true,
      categoryId: true,
      merchantId: true,
      account: { select: { currency: true } },
    },
  });

  const currency = await getDisplayCurrency();
  const toDisplay = await displayConverter(
    currency,
    rows.map((r) => r.account.currency),
  );

  // Bucket the window's spend by the same identity the budget items carry, so each
  // item reads only the transactions that are actually its own.
  const byKey = new Map<string, number[]>();
  for (const row of rows) {
    const key = streamKey(row);
    const amount = toDisplay(money(row.amount), row.account.currency, row.date);
    const list = byKey.get(key);
    if (list) list.push(amount);
    else byKey.set(key, [amount]);
  }

  const out: Refinement[] = [];
  for (const item of budget.items) {
    const amounts = byKey.get(streamKey(item)) ?? [];
    const from = money(item.amount);
    const to = refinedAmount(from, amounts, item.frequency as Frequency, item.interval, DAYS);
    if (to === null || to === from) continue;
    out.push({ id: item.id, from, to });
  }
  return out;
}
