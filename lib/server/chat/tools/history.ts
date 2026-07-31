// No `import "server-only"`: loaded by the worker's budget inference as well as by a
// chat turn. Takes its scoped db as an argument for the same reason.
import { catKey, type Catalog } from "../../../budget/llm";
import type { ScopedDb } from "../../db";
import { money } from "../../money";
import { displayFxFor, type DisplayFx } from "../../budget/fx";
import { MAX_MONTHS } from "../client";

// The history the reading tools serve from, loaded once and held in memory.
//
// Both conversations want the same thing: every non-transfer, categorised transaction
// in the window, converted to one display currency, bucketed by spending area. Doing
// it once and slicing in memory is what makes `get_transactions` cheap enough for a
// model to page through an area forty rows at a time — and it is what lets the whole
// set be filtered by category, payee or date without a query per tool call.
//
// The budget inference needs the counts up front for its envelope, so it loads
// eagerly. A chat may never mention a transaction, so it loads on first use — see
// `lazyHistory`.

/** The transaction fields the model is given. The area is stated once per result,
 *  not repeated on every row, so it is not carried here. */
export type TxRow = {
  date: string;
  amount: number;
  type: string;
  category: string | null;
  merchant: string | null;
  account: string | null;
  description: string;
  reference: string | null;
  particulars: string | null;
  code: string | null;
  /** Last digits of the card used, when there was one. A payee that covers several
   *  commitments (two mobile lines on one account) often differs only here. */
  cardSuffix: string | null;
};

/** One spending area — a category group — and everything in it, newest first. */
export type Area = {
  groupId: string;
  name: string;
  txns: TxRow[];
};

export type History = {
  areas: Map<string, Area>;
  /** The same areas keyed by lower-cased name, which is how a model names them. */
  byName: Map<string, Area>;
  /** Every transaction that went in, across all areas. */
  count: number;
  monthsOfHistory: number;
  currency: string;
};

/**
 * Read the window and bucket it into areas.
 *
 * The transfer exclusion is the one the deterministic path and the rest of the app
 * use: a transfer between your own accounts is neither income nor spending. Every
 * category and type is otherwise in scope — only an uncategorised row is dropped,
 * since it carries no group to file anything under.
 *
 * Amounts are converted to the display currency up front, so the model reasons in one
 * currency and anything it says back needs no per-row rate applied to it.
 */
export async function loadHistory(db: ScopedDb, now: Date): Promise<History> {
  const cutoff = new Date(now.getTime() - MAX_MONTHS * 30.44 * 86_400_000);

  const rows = await db.transaction.findMany({
    where: {
      date: { gte: cutoff },
      type: { notIn: ["TRANSFER"] },
      transferGroupId: null,
      categoryGroupId: { not: null },
    },
    orderBy: { date: "desc" },
    select: {
      date: true,
      amount: true,
      type: true,
      categoryGroupId: true,
      categoryGroup: { select: { name: true } },
      category: { select: { name: true } },
      merchant: { select: { name: true } },
      account: { select: { name: true, currency: true } },
      description: true,
      reference: true,
      particulars: true,
      code: true,
      cardSuffix: true,
    },
  });

  const { currency, toDisplay } = await displayFxFor(db);

  const areas = new Map<string, Area>();
  let count = 0;
  let oldest = Infinity;
  for (const r of rows) {
    if (!r.categoryGroupId || !r.categoryGroup) continue;
    count++;
    oldest = Math.min(oldest, r.date.getTime());
    const area = areas.get(r.categoryGroupId) ?? {
      groupId: r.categoryGroupId,
      name: r.categoryGroup.name,
      txns: [],
    };
    area.txns.push({
      date: r.date.toISOString().slice(0, 10),
      amount: Math.round(toDisplay(money(r.amount), r.account.currency, r.date) * 100) / 100,
      type: r.type,
      category: r.category?.name ?? null,
      merchant: r.merchant?.name ?? null,
      account: r.account.name ?? null,
      description: r.description,
      reference: r.reference,
      particulars: r.particulars,
      code: r.code,
      cardSuffix: r.cardSuffix,
    });
    areas.set(r.categoryGroupId, area);
  }

  const monthsOfHistory =
    count === 0
      ? 0
      : Math.min(MAX_MONTHS, Math.round((now.getTime() - oldest) / (30.44 * 86_400_000)));

  return {
    areas,
    byName: new Map([...areas.values()].map((a) => [a.name.toLowerCase(), a])),
    count,
    monthsOfHistory,
    currency,
  };
}

/**
 * A `History` accessor that loads at most once, whenever it is first asked.
 *
 * A chat turn builds its tool context before it knows what the model will ask for,
 * and most turns never touch a transaction — "rename this budget item" should not
 * read three years of history to answer. The promise is cached rather than the
 * result, so two tools calling it in the same turn share one load.
 */
export function lazyHistory(db: ScopedDb, now: Date): () => Promise<History> {
  let pending: Promise<History> | null = null;
  return () => (pending ??= loadHistory(db, now));
}

/** An accessor over history that has already been read. */
export function eagerHistory(history: History): () => Promise<History> {
  return () => Promise.resolve(history);
}

/**
 * The display-currency converter, loaded at most once per turn.
 *
 * Same reasoning as `lazyHistory`, and the same caching of the promise rather than
 * the result: `displayFxFor` is two queries, the transaction tools want it on every
 * row they return, and a turn that only renames a budget item wants it never. The
 * caller that needs the currency name up front gets it by awaiting this once —
 * which is the load, not a second one.
 */
export function lazyFx(db: ScopedDb): () => Promise<DisplayFx> {
  let pending: Promise<DisplayFx> | null = null;
  return () => (pending ??= displayFxFor(db));
}

/** Build the name→id lookups from the catalog and this workspace's merchants. */
export async function loadCatalog(db: ScopedDb): Promise<Catalog> {
  const [groups, categories, merchants] = await Promise.all([
    db.categoryGroup.findMany({ select: { id: true, name: true } }),
    db.category.findMany({ select: { id: true, name: true, groupId: true } }),
    db.merchant.findMany({ select: { id: true, name: true } }),
  ]);

  return {
    groups: new Map(groups.map((g) => [g.name.toLowerCase(), { id: g.id, name: g.name }])),
    categories: new Map(
      categories
        .filter((c): c is typeof c & { groupId: string } => c.groupId !== null)
        .map((c) => [catKey(c.groupId, c.name), { id: c.id, name: c.name }]),
    ),
    merchants: new Map(merchants.map((m) => [m.name.toLowerCase(), { id: m.id, name: m.name }])),
  };
}
