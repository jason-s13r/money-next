// No `import "server-only"`: it sits in the same registry as the tools the worker
// loads. See the note at the top of registry.ts.
import { mintId } from "../../../ids";
import { asIds, asText, type ToolContext } from "./registry";

// Turning what a model *says* into a row it may act on.
//
// Every write tool in this directory has the same first problem and it is not the
// write: a model names a category, a payee, a tag or a transaction, and none of those
// names is an id. `findBudget` in read.ts solved it for budgets and set the shape the
// rest follow — resolve case-insensitively, refuse an ambiguous name rather than
// picking one, and answer a failure with the real candidates, because a model that can
// see the list fixes its call on the next turn instead of guessing again.
//
// The one rule worth stating twice: **a name that matches two rows is an error.** Two
// spending areas both have a "Fees" category; two merchant ids both read "Kamo Vets".
// Choosing for the model would be a coin toss over somebody's ledger, so the way out
// is the id, which these functions return on every result precisely so the model has
// one to send back.

/**
 * The most rows one write may touch.
 *
 * Not a database limit — `updateMany` would take ten thousand ids happily. It is a
 * blast-radius limit: a model working through an uncategorised queue should recategorise
 * a batch it has named and looked at, and be made to ask for the next batch, rather than
 * relabel a household's entire history on one confident guess. The tools say so in their
 * errors, so the way forward is obvious.
 */
export const MAX_WRITE_ROWS = 200;

/** Result shape shared by every lookup here: the row, or a readable error with the
 *  candidates that would have worked. */
export type Found<T> = { found: T } | { error: string; [hint: string]: unknown };

export function isError<T>(result: Found<T>): result is { error: string } {
  return "error" in result;
}

// --- Categories. ------------------------------------------------------------

export type FoundCategory = {
  id: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  direction: string;
};

/**
 * Resolve a category by name (or by its `nzfcc_...` id), optionally narrowed to one
 * spending area.
 *
 * The catalog is the NZFCC standard's, mirrored — so a category is not something a
 * household invents, and a name the model made up must fail rather than being created.
 * That is the whole reason this reads the catalog instead of get-or-creating like the
 * label lookup below does: labels are the user's own vocabulary, categories are not.
 *
 * `area` is what makes an ambiguous name answerable: "Fees" exists under more than one
 * area, and a model that knows which area it is working in can say so instead of being
 * asked to find an id.
 */
export async function findCategory(
  ctx: ToolContext,
  key: string,
  area?: string,
): Promise<Found<FoundCategory>> {
  const wanted = key.trim();
  if (!wanted) return { error: "No category was named." };

  const rows = await ctx.db.category.findMany({
    where: {
      OR: [{ id: wanted }, { name: { equals: wanted, mode: "insensitive" } }],
      ...(area ? { group: { is: { name: { equals: area, mode: "insensitive" } } } } : {}),
    },
    select: {
      id: true,
      name: true,
      direction: true,
      groupId: true,
      group: { select: { name: true } },
    },
  });

  const shape = (row: (typeof rows)[number]): FoundCategory => ({
    id: row.id,
    name: row.name,
    groupId: row.groupId,
    groupName: row.group?.name ?? null,
    direction: row.direction,
  });

  // An id wins outright — it is the identity, not a description of one.
  const byId = rows.find((row) => row.id === wanted);
  if (byId) return { found: shape(byId) };

  if (rows.length === 1) return { found: shape(rows[0]) };
  if (rows.length > 1) {
    return {
      error:
        `More than one category is called "${key}": ` +
        `${rows.map((r) => `${r.name} in ${r.group?.name ?? "no area"} (id ${r.id})`).join(", ")}. ` +
        "Say which spending area you mean, or name it by its id.",
    };
  }

  // Nothing matched. The whole catalog is hundreds of rows, so the near misses are
  // what is worth sending back — a model that half-remembered the name gets it right
  // next turn, and one that invented a category learns the catalog is not open.
  const near = await ctx.db.category.findMany({
    where: { name: { contains: firstWord(wanted), mode: "insensitive" } },
    orderBy: { name: "asc" },
    take: 20,
    select: { name: true, group: { select: { name: true } } },
  });
  return {
    error: `No category called "${key}". Categories come from a fixed catalog and cannot be invented.`,
    ...(near.length > 0
      ? { didYouMean: near.map((r) => `${r.name} (${r.group?.name ?? "no area"})`) }
      : {}),
  };
}

// --- Merchants. -------------------------------------------------------------

export type FoundMerchant = { id: string; name: string };

/**
 * Resolve a payee by name or id, and create one when asked to.
 *
 * Creating is opt-in (`create`) rather than automatic, because the failure modes point
 * opposite ways: silently minting "Countdown " beside the "Countdown" that already
 * exists splits a household's spending in two for good, while refusing outright would
 * make the tool useless for the genuinely new corner shop. So a miss reports the near
 * misses and the model decides — which is the same conversation a person has with the
 * merchant picker on the transaction page.
 *
 * A minted merchant carries this instance's namespace (`user_...`, see `mintId`) and
 * the workspace id, which is what makes it private; the scoped client refuses to write
 * one that says otherwise.
 */
export async function findMerchant(
  ctx: ToolContext,
  key: string,
  create = false,
): Promise<Found<FoundMerchant> & { created?: boolean }> {
  const wanted = key.trim();
  if (!wanted) return { error: "No payee was named." };

  const rows = await ctx.db.merchant.findMany({
    where: { OR: [{ id: wanted }, { name: { equals: wanted, mode: "insensitive" } }] },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const byId = rows.find((row) => row.id === wanted);
  if (byId) return { found: byId };
  if (rows.length === 1) return { found: rows[0] };
  if (rows.length > 1) {
    return {
      error:
        `More than one payee is called "${key}": ${rows.map((r) => `id ${r.id}`).join(", ")}. ` +
        "One business can hold several ids. Name the one you mean by its id.",
    };
  }

  if (create) {
    const merchant = await ctx.db.merchant.create({
      data: { id: mintId("merchant"), workspaceId: ctx.db.$workspaceId, name: wanted },
      select: { id: true, name: true },
    });
    return { found: merchant, created: true };
  }

  const near = await ctx.db.merchant.findMany({
    where: { name: { contains: firstWord(wanted), mode: "insensitive" } },
    orderBy: { name: "asc" },
    take: 20,
    select: { name: true },
  });
  return {
    error: `No payee called "${key}". Call again with create true to add it, or use one of the existing names.`,
    ...(near.length > 0 ? { didYouMean: near.map((r) => r.name) } : {}),
  };
}

// --- Labels. ----------------------------------------------------------------

export type FoundLabel = { id: string; name: string };

/**
 * Resolve one of the workspace's own tags by name or id.
 *
 * Names are unique per workspace, so there is no ambiguous case to refuse — unlike
 * every other lookup here. Creating is the caller's business: `create_label` and
 * `add_label_to_transactions` each decide whether a miss is a mistake or a new tag.
 */
export async function findLabel(ctx: ToolContext, key: string): Promise<Found<FoundLabel>> {
  const wanted = key.trim();
  if (!wanted) return { error: "No label was named." };

  const row = await ctx.db.label.findFirst({
    where: { OR: [{ id: wanted }, { name: { equals: wanted, mode: "insensitive" } }] },
    select: { id: true, name: true },
  });
  if (row) return { found: row };

  const all = await ctx.db.label.findMany({ orderBy: { name: "asc" }, select: { name: true } });
  return {
    error: `No label called "${key}".`,
    labels: all.map((r) => r.name),
  };
}

// --- Transactions. ----------------------------------------------------------

/** The columns every enrichment write reads before it writes: what the field was, so
 *  the change log can say, and enough to describe the row back to the model. */
export const TX_FOR_WRITE = {
  id: true,
  date: true,
  description: true,
  type: true,
  amount: true,
  categoryId: true,
  category: { select: { name: true } },
  merchantId: true,
  merchant: { select: { name: true } },
  account: { select: { currency: true } },
} as const;

export type TxForWrite = {
  id: string;
  date: Date;
  description: string;
  type: string;
  categoryId: string | null;
  category: { name: string } | null;
  merchantId: string | null;
  merchant: { name: string } | null;
};

/**
 * The transactions a write was aimed at, having checked they exist and that there are
 * not too many of them.
 *
 * Ids the scoped client did not return name another workspace's rows or nothing at
 * all, and either way the model must be told which ones rather than have them silently
 * dropped — a tool that reports "42 categorised" over a list of 50 has told the person
 * something untrue about their own ledger.
 */
export async function resolveTransactions(
  ctx: ToolContext,
  raw: unknown,
): Promise<{ error: string } | { rows: (TxForWrite & { amount: unknown })[]; missing: string[] }> {
  const ids = asIds(raw);
  if (ids.length === 0) {
    return { error: "No transaction ids were given. Find them first with search_transactions." };
  }
  if (ids.length > MAX_WRITE_ROWS) {
    return {
      error: `That is ${ids.length} transactions; ${MAX_WRITE_ROWS} is the most one call may change. Do it in batches.`,
    };
  }

  const rows = await ctx.db.transaction.findMany({
    where: { id: { in: ids } },
    select: TX_FOR_WRITE,
  });
  const seen = new Set(rows.map((row) => row.id));
  return { rows, missing: ids.filter((id) => !seen.has(id)) };
}

/** The first word of what the model said, for a "did you mean" that still matches when
 *  the rest of the phrase was invented. */
function firstWord(text: string): string {
  return asText(text.split(/\s+/)[0]) || text;
}
