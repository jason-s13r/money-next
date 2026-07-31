// No `import "server-only"`: it sits in the same registry as the tools the worker
// loads. See the note at the top of budget-write.ts, which applies word for word.
import { changeRows, type FieldChangeEntry } from "../../changes";
import { findCategory, findMerchant, isError, resolveTransactions } from "./lookup";
import { asBool, asText, type Tool, type ToolContext } from "./registry";

// Changing what a transaction is *about* — its category and its payee.
//
// These do exactly what the buttons on the transaction page do
// (app/w/[workspace]/transactions/[transactionId]/actions/), and the three things they
// do besides the update are the reason they are a copy of that logic rather than a bare
// `updateMany`:
//
//   1. **The field is marked `user`-owned.** A hand-set field is one the Akahu sync must
//      stop overwriting — it records a `TransactionConflict` instead. A chat edit is a
//      person's decision arriving through a different door, so it claims the field the
//      same way. Anything less and the next sync would quietly undo the conversation.
//   2. **The change is logged.** `FieldChange` is the answer to "why does this say
//      that?", and an edit missing from it is a hole in the only record there is.
//   3. **An open conflict on the field is settled.** Somebody has just made an
//      authoritative choice; leaving the flag up would ask them to make it again.
//
// The category setter also keeps `categoryGroupId` in step with the category, because
// the metrics group by that column and a row whose group disagrees with its category is
// counted in the wrong place on every screen at once.
//
// Written in bulk throughout. A model working an uncategorised queue is doing the thing
// the "apply to similar transactions" button exists for, and one call over forty ids is
// both faster and easier for a person to read back than forty calls.

const IDS = {
  type: "array",
  items: { type: "string" },
  description:
    "The transaction ids, as search_transactions or get_uncategorised_transactions gave them.",
} as const;

export const categoriseTransactions: Tool = {
  name: "categorise_transactions",
  description:
    "Set the category on one or more transactions. Categories come from a fixed catalog — you cannot invent one — so name it exactly as a tool gave it, and say which spending area you mean if the name is used in more than one. " +
    "The spending area follows the category automatically. Marks the field as the household's own, so a later bank sync will not overwrite it.",
  write: "enrichment",
  parameters: {
    type: "object",
    properties: {
      transactionIds: IDS,
      category: {
        type: "string",
        description: "The category name (or its id). Leave out and set clear true to remove it.",
      },
      area: {
        type: "string",
        description:
          "Optional. The spending area the category belongs to, when its name is used in more than one.",
      },
      clear: { type: "boolean", description: "True to remove the category instead of setting one." },
    },
    required: ["transactionIds"],
  },
  async handler(args, ctx) {
    const target = await resolveTransactions(ctx, args.transactionIds);
    if ("error" in target) return target;

    const clear = asBool(args.clear);
    const name = asText(args.category);
    if (!clear && !name) {
      return { error: "Name a category, or call again with clear true to remove the one there." };
    }

    let category: { id: string; name: string; groupId: string | null; groupName: string | null } | null =
      null;
    if (!clear) {
      const found = await findCategory(ctx, name, asText(args.area) || undefined);
      if (isError(found)) return found;
      category = found.found;
    }

    // Only the rows that would actually change. `updateMany` over the rest would write
    // the same value back, and — more to the point — the change log's one rule is that a
    // row in it means the value moved.
    const changing = target.rows.filter((row) => row.categoryId !== (category?.id ?? null));

    if (changing.length > 0) {
      await ctx.db.transaction.updateMany({
        where: { id: { in: changing.map((row) => row.id) } },
        data: {
          categoryId: category?.id ?? null,
          categoryGroupId: category?.groupId ?? null,
          categorySource: "user",
        },
      });

      await recordChanges(
        ctx,
        changing.map((row) => ({
          transactionId: row.id,
          field: "category" as const,
          fromId: row.categoryId,
          fromLabel: row.category?.name ?? null,
          toId: category?.id ?? null,
          toLabel: category?.name ?? null,
        })),
      );

      await ctx.db.transactionConflict.deleteMany({
        where: { transactionId: { in: changing.map((row) => row.id) }, field: "category" },
      });
    }

    return {
      category: category?.name ?? null,
      area: category?.groupName ?? null,
      changed: changing.length,
      // Said separately from `changed` so a model does not read "3 of 20" as a failure
      // and try again: the other seventeen were already right.
      alreadySet: target.rows.length - changing.length,
      ...missingNote(target.missing),
      note: category
        ? `Set on ${changing.length} transaction(s). These now belong to the household, not to the bank's guess.`
        : `Cleared on ${changing.length} transaction(s).`,
    };
  },
};

export const setTransactionsMerchant: Tool = {
  name: "set_transaction_merchant",
  description:
    "Set the payee on one or more transactions. Names an existing payee by default; pass create true to add one the household has not used before, which is what a shop the bank could not recognise needs. " +
    "Marks the field as the household's own, so a later bank sync will not overwrite it.",
  write: "enrichment",
  parameters: {
    type: "object",
    properties: {
      transactionIds: IDS,
      merchant: {
        type: "string",
        description: "The payee name (or its id). Leave out and set clear true to remove it.",
      },
      create: {
        type: "boolean",
        description:
          "True to create this payee if no existing one has that name. Check the suggestions on a failure first — a near-duplicate splits a household's spending in two for good.",
      },
      clear: { type: "boolean", description: "True to remove the payee instead of setting one." },
    },
    required: ["transactionIds"],
  },
  async handler(args, ctx) {
    const target = await resolveTransactions(ctx, args.transactionIds);
    if ("error" in target) return target;

    const clear = asBool(args.clear);
    const name = asText(args.merchant);
    if (!clear && !name) {
      return { error: "Name a payee, or call again with clear true to remove the one there." };
    }

    let merchant: { id: string; name: string } | null = null;
    let created = false;
    if (!clear) {
      const found = await findMerchant(ctx, name, asBool(args.create));
      if (isError(found)) return found;
      merchant = found.found;
      created = found.created === true;
    }

    const changing = target.rows.filter((row) => row.merchantId !== (merchant?.id ?? null));

    if (changing.length > 0) {
      await ctx.db.transaction.updateMany({
        where: { id: { in: changing.map((row) => row.id) } },
        data: { merchantId: merchant?.id ?? null, merchantSource: "user" },
      });

      await recordChanges(
        ctx,
        changing.map((row) => ({
          transactionId: row.id,
          field: "merchant" as const,
          fromId: row.merchantId,
          fromLabel: row.merchant?.name ?? null,
          toId: merchant?.id ?? null,
          toLabel: merchant?.name ?? null,
        })),
      );

      await ctx.db.transactionConflict.deleteMany({
        where: { transactionId: { in: changing.map((row) => row.id) }, field: "merchant" },
      });
    }

    return {
      merchant: merchant?.name ?? null,
      merchantId: merchant?.id ?? null,
      ...(created ? { createdPayee: true } : {}),
      changed: changing.length,
      alreadySet: target.rows.length - changing.length,
      ...missingNote(target.missing),
    };
  },
};

// --- Shared. ----------------------------------------------------------------

/**
 * Log a batch of edits as the person's own.
 *
 * `recordUserChanges` is the equivalent on the request side and reads the actor from
 * the session itself, on the argument that threading a user id through nine call sites
 * is nine chances to forget one. That argument holds there and cannot hold here: a chat
 * turn outlives the request that started it (lib/server/chat/runs.ts), so there is no
 * session left to read by the time a tool writes. `ToolContext.actorUserId` is captured
 * while there still is one, and this is where it is spent — with `source: "user"`,
 * because the person asked for this in as many words. The model is the instrument, not
 * the author.
 */
async function recordChanges(ctx: ToolContext, entries: FieldChangeEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await ctx.db.fieldChange.createMany({
    data: changeRows(ctx.db.$workspaceId, "user", entries, { actorUserId: ctx.actorUserId }),
  });
}

/** Ids that named nothing this workspace holds. Reported rather than dropped: a tool
 *  that says "40 changed" over a list of 50 has told somebody something untrue. */
function missingNote(missing: string[]) {
  return missing.length > 0
    ? {
        notFound: missing,
        warning: `${missing.length} id(s) matched no transaction here and were skipped.`,
      }
    : {};
}

export const ENRICH_WRITE_TOOLS: Tool[] = [categoriseTransactions, setTransactionsMerchant];
