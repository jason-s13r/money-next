// No `import "server-only"`: it sits in the same registry as the tools the worker
// loads. See the note at the top of registry.ts.
import { mintId } from "../../../ids";
import { money } from "../../money";
import { findLabel, isError, resolveTransactions } from "./lookup";
import { asText, type Tool } from "./registry";

// The household's own tags, and everything a conversation can do with them.
//
// Labels are the one enrichment that is purely the user's — nothing about them is
// mirrored from Akahu — which changes what these tools have to do compared with their
// neighbours in enrich-write.ts. There is no `*Source` to claim, no
// `TransactionConflict` to settle, and no `FieldChange` to write: a sync never touches a
// tag, so there is nobody to disagree with. They are plain scoped writes.
//
// It also changes what the *model* may do. A category cannot be invented, because the
// catalog is a standard; a label is a word somebody made up for their own filing, so
// inventing one is the point. That is why `create_label` exists at all and why
// `add_label_to_transactions` will mint one on the way past when asked.
//
// Two families of reserved name are worth knowing about and are called out in
// `list_labels`: `ingested-<date>`, which every sync stamps on that run's arrivals, and
// `category-rule-<slug>` / `merchant-rule-<slug>` / `transfer-rule`, which mark what a
// rule run changed. They are ordinary rows — the app re-creates them by name when it
// needs them — so nothing stops a model deleting one, and the label saying what it is
// for is the only thing that discourages it.

export const listLabels: Tool = {
  name: "list_labels",
  description:
    "List the household's tags: what each is called, how many transactions carry it, and what those come to. Tags are their own vocabulary, not the bank's — they are for groupings the categories cannot express, like a holiday, a shared cost to be paid back, or something to claim at tax time.",
  parameters: { type: "object", properties: {}, required: [] },
  async handler(_args, ctx) {
    const [labels, joins] = await Promise.all([
      ctx.db.label.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, createdAt: true },
      }),
      ctx.db.transactionLabel.findMany({
        select: {
          labelId: true,
          transaction: {
            select: { amount: true, date: true, account: { select: { currency: true } } },
          },
        },
      }),
    ]);

    const { currency, toDisplay } = await ctx.fx();
    const totals = new Map<string, { count: number; net: number }>();
    for (const join of joins) {
      const running = totals.get(join.labelId) ?? { count: 0, net: 0 };
      running.count++;
      running.net += toDisplay(
        money(join.transaction.amount),
        join.transaction.account.currency,
        join.transaction.date,
      );
      totals.set(join.labelId, running);
    }

    return {
      currency,
      labels: labels.map((label) => {
        const running = totals.get(label.id) ?? { count: 0, net: 0 };
        return {
          label: label.name,
          id: label.id,
          transactions: running.count,
          net: Math.round(running.net * 100) / 100,
          // The two the app writes for itself. Said out loud because they look like
          // anybody's tags and are not: renaming one only makes the next sync create it
          // again under the old name, beside the renamed one.
          ...(AUTOMATIC.test(label.name) ? { managedByTheApp: true } : {}),
        };
      }),
    };
  },
};

export const createLabel: Tool = {
  name: "create_label",
  description:
    "Create a tag. Names are unique per household, so asking for one that already exists gives you that one back rather than a duplicate. Suggest tags to the household before making them — a tag nobody uses is clutter on every transaction screen.",
  write: "enrichment",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "What to call the tag." } },
    required: ["name"],
  },
  async handler(args, ctx) {
    const name = asText(args.name);
    if (!name) return { error: "A tag needs a name." };

    const existing = await ctx.db.label.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { id: true, name: true },
    });
    if (existing) return { label: existing.name, id: existing.id, alreadyExisted: true };

    const label = await ctx.db.label.create({
      data: { id: mintId("label"), workspaceId: ctx.db.$workspaceId, name },
      select: { id: true, name: true },
    });
    return { label: label.name, id: label.id, created: true };
  },
};

export const renameLabel: Tool = {
  name: "rename_label",
  description:
    "Rename a tag. Every transaction carrying it keeps it — the tag is the same row under a new name.",
  write: "enrichment",
  parameters: {
    type: "object",
    properties: {
      label: { type: "string", description: "The tag as it is called now, or its id." },
      name: { type: "string", description: "What to call it instead." },
    },
    required: ["label", "name"],
  },
  async handler(args, ctx) {
    const found = await findLabel(ctx, asText(args.label));
    if (isError(found)) return found;

    const name = asText(args.name);
    if (!name) return { error: "A tag needs a name." };

    const clash = await ctx.db.label.findFirst({
      where: { name: { equals: name, mode: "insensitive" }, id: { not: found.found.id } },
      select: { id: true },
    });
    // Names are unique per workspace, so this would fail on the constraint anyway. It is
    // caught here to say the useful thing: merging two tags is a real intention, and it
    // is not what renaming does.
    if (clash) {
      return {
        error: `There is already a tag called "${name}". Rename cannot merge two tags — move the transactions across with add_label_to_transactions, then delete the empty one.`,
      };
    }

    await ctx.db.label.updateMany({ where: { id: found.found.id }, data: { name } });
    return { was: found.found.name, label: name };
  },
};

export const deleteLabel: Tool = {
  name: "delete_label",
  description:
    "Delete a tag entirely. It comes off every transaction carrying it, and that cannot be undone — say how many that is and get a yes before you call this. The transactions themselves are untouched.",
  write: "enrichment",
  parameters: {
    type: "object",
    properties: { label: { type: "string", description: "The tag name, or its id." } },
    required: ["label"],
  },
  async handler(args, ctx) {
    const found = await findLabel(ctx, asText(args.label));
    if (isError(found)) return found;

    const tagged = await ctx.db.transactionLabel.count({ where: { labelId: found.found.id } });
    // The join cascades from the label, so this one delete takes the tags with it.
    const { count } = await ctx.db.label.deleteMany({ where: { id: found.found.id } });
    if (count === 0) return { error: `"${found.found.name}" no longer exists.` };

    return { deleted: found.found.name, untaggedTransactions: tagged };
  },
};

export const addLabelToTransactions: Tool = {
  name: "add_label_to_transactions",
  description:
    "Tag one or more transactions. Re-tagging one that already carries the tag does nothing, so a list that overlaps an earlier one is safe. Pass create true to mint the tag if it does not exist yet.",
  write: "enrichment",
  parameters: {
    type: "object",
    properties: {
      label: { type: "string", description: "The tag name, or its id." },
      transactionIds: {
        type: "array",
        items: { type: "string" },
        description: "The transaction ids, as a search gave them.",
      },
      create: {
        type: "boolean",
        description: "True to create the tag if the household has no tag of that name.",
      },
    },
    required: ["label", "transactionIds"],
  },
  async handler(args, ctx) {
    const target = await resolveTransactions(ctx, args.transactionIds);
    if ("error" in target) return target;

    const name = asText(args.label);
    const found = await findLabel(ctx, name);
    let label: { id: string; name: string };
    if (isError(found)) {
      if (args.create !== true) return found;
      label = await ctx.db.label.create({
        data: { id: mintId("label"), workspaceId: ctx.db.$workspaceId, name },
        select: { id: true, name: true },
      });
    } else {
      label = found.found;
    }

    // Skipped rather than upserted one at a time: `createMany` would trip the composite
    // primary key on a row that already carries the tag, and the whole point of this
    // tool is that a second overlapping call is harmless.
    const already = await ctx.db.transactionLabel.findMany({
      where: { labelId: label.id, transactionId: { in: target.rows.map((row) => row.id) } },
      select: { transactionId: true },
    });
    const has = new Set(already.map((row) => row.transactionId));
    const toAdd = target.rows.filter((row) => !has.has(row.id));

    if (toAdd.length > 0) {
      await ctx.db.transactionLabel.createMany({
        data: toAdd.map((row) => ({
          workspaceId: ctx.db.$workspaceId,
          transactionId: row.id,
          labelId: label.id,
        })),
      });
    }

    return {
      label: label.name,
      tagged: toAdd.length,
      alreadyTagged: has.size,
      ...(target.missing.length > 0 ? { notFound: target.missing } : {}),
    };
  },
};

export const removeLabelFromTransactions: Tool = {
  name: "remove_label_from_transactions",
  description:
    "Take a tag off one or more transactions. The tag itself stays, on everything else that carries it.",
  write: "enrichment",
  parameters: {
    type: "object",
    properties: {
      label: { type: "string", description: "The tag name, or its id." },
      transactionIds: {
        type: "array",
        items: { type: "string" },
        description: "The transaction ids.",
      },
    },
    required: ["label", "transactionIds"],
  },
  async handler(args, ctx) {
    const target = await resolveTransactions(ctx, args.transactionIds);
    if ("error" in target) return target;

    const found = await findLabel(ctx, asText(args.label));
    if (isError(found)) return found;

    const { count } = await ctx.db.transactionLabel.deleteMany({
      where: { labelId: found.found.id, transactionId: { in: target.rows.map((row) => row.id) } },
    });

    return {
      label: found.found.name,
      untagged: count,
      ...(target.missing.length > 0 ? { notFound: target.missing } : {}),
    };
  },
};

/** The tags the app writes for itself — a dated one per sync, and one per effect a
 *  rule had. See lib/server/labels.ts. */
const AUTOMATIC = /^(ingested-\d{4}-\d{2}-\d{2}|(category|merchant)-rule-.+|transfer-rule)$/;

export const LABEL_READ_TOOLS: Tool[] = [listLabels];

export const LABEL_WRITE_TOOLS: Tool[] = [
  createLabel,
  renameLabel,
  deleteLabel,
  addLabelToTransactions,
  removeLabelFromTransactions,
];
