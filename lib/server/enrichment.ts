// Setting a transaction's category, merchant or tax year by hand — the one path
// every caller goes through. Writing the field, logging the rows that actually
// changed and clearing the settled conflict have to commit together: under the
// scoped client each would otherwise be its own transaction, and a failure
// between them leaves the field changed with nothing in the log to say so.
//
// No `import "server-only"`: nothing here reaches for a request. What keeps
// this honest is the scoped client the caller passes in, not the module's
// location.

import { recordUserChanges, type FieldChangeEntry } from "./changes";
import { withScopedTx, type ScopedDb, type ScopedTx } from "./db";

/** The two fields a person can set by hand *and* Akahu can disagree with — which
 *  is why they need a conflict settled. Labels are neither (nothing mirrors
 *  them), so they are plain writes. */
export type EnrichmentField = "category" | "merchant";

/** The resolved target of the edit: a row proven to be in this workspace, or
 *  `null` for clearing the field. `groupId` is category-only — the denormalised
 *  `Transaction.categoryGroupId` has to move with it. */
type Value = { id: string; name: string; groupId?: string | null } | null;

/** Prove the id names a row this workspace can see, and read the label the log
 *  will need. The scoped client is what makes this a permission check and not
 *  just a spelling check: an id belonging to another workspace simply isn't
 *  found, so it throws here rather than being written and rejected later by RLS. */
async function resolveValue(
  db: ScopedDb,
  field: EnrichmentField,
  valueId: string | null,
): Promise<Value> {
  if (valueId === null) return null;

  if (field === "category") {
    const category = await db.category.findUnique({
      where: { id: valueId },
      select: { id: true, name: true, groupId: true },
    });
    if (!category) throw new Error(`Unknown category: ${valueId}`);
    return category;
  }

  const merchant = await db.merchant.findUnique({
    where: { id: valueId },
    select: { id: true, name: true },
  });
  if (!merchant) throw new Error(`Unknown merchant: ${valueId}`);
  return merchant;
}

/** What the field was, per row, in the shape the log wants. One read for the
 *  whole batch: `updateMany` is a single statement and the log must not turn it
 *  into N round trips. Rows from another workspace aren't returned — and so
 *  aren't logged either, which matches exactly what the update will refuse to
 *  touch. */
async function readPriors(tx: ScopedTx, field: EnrichmentField, ids: string[]) {
  if (field === "category") {
    const rows = await tx.transaction.findMany({
      where: { id: { in: ids } },
      select: { id: true, categoryId: true, category: { select: { name: true } } },
    });
    return rows.map((row) => ({ id: row.id, valueId: row.categoryId, label: row.category?.name ?? null }));
  }

  const rows = await tx.transaction.findMany({
    where: { id: { in: ids } },
    select: { id: true, merchantId: true, merchant: { select: { name: true } } },
  });
  return rows.map((row) => ({ id: row.id, valueId: row.merchantId, label: row.merchant?.name ?? null }));
}

/**
 * Set `field` to `valueId` (or clear it) on every transaction named, as one
 * transaction. The field is stamped `user`-owned, which stops the next Akahu
 * sync overwriting it — the sync raises a `TransactionConflict` instead. See
 * the notes on `Transaction.categorySource` in the schema.
 *
 * Revalidation is deliberately not here: which paths a given edit invalidates
 * is the caller's business — the detail page revalidates itself, the bulk bar
 * revalidates the listing it was invoked from.
 *
 * Returns how many of the named transactions were in this workspace and
 * therefore written. A bulk action tolerates ids it can't see (the selection is
 * filtered, not rejected); a single-row setter handed an id it can't see has
 * been handed a bad id and should say so. Returning the count instead of
 * deciding keeps `setTransactionCategory` from silently no-op'ing on a probe.
 */
export async function applyEnrichment(
  db: ScopedDb,
  field: EnrichmentField,
  transactionIds: string[],
  valueId: string | null,
): Promise<number> {
  if (transactionIds.length === 0) return 0;

  // Outside the transaction: it is a read of a catalog row that the edit does not
  // touch, and resolving it inside would hold the connection for a lookup that
  // can just as well fail before one is taken out.
  const value = await resolveValue(db, field, valueId);

  return withScopedTx(db, async (tx) => {
    // Read inside the transaction, not before it. The priors are what the log
    // will claim the field *was*, so they have to be the same snapshot the update
    // writes over — read outside, a concurrent edit between the two makes the log
    // assert a change that never happened.
    const priors = await readPriors(tx, field, transactionIds);

    await tx.transaction.updateMany({
      where: { id: { in: transactionIds } },
      data:
        field === "category"
          ? {
              categoryId: value?.id ?? null,
              categoryGroupId: value?.groupId ?? null,
              categorySource: "user",
            }
          : { merchantId: value?.id ?? null, merchantSource: "user" },
    });

    // Log the change, not the click: re-picking the value a row already has is a
    // no-op, and logging it would drown the rows that did change.
    const entries: FieldChangeEntry[] = priors
      .filter((prior) => prior.valueId !== (value?.id ?? null))
      .map((prior) => ({
        transactionId: prior.id,
        field,
        fromId: prior.valueId,
        fromLabel: prior.label,
        toId: value?.id ?? null,
        toLabel: value?.name ?? null,
      }));
    await recordUserChanges(tx, entries);

    // The user just made an authoritative choice for this field: any outstanding
    // disagreement with Akahu about it is settled by that.
    await tx.transactionConflict.deleteMany({
      where: { transactionId: { in: transactionIds }, field },
    });

    // The rows the scoped read could see, which is exactly the set `updateMany`
    // wrote — both are filtered by the same client.
    return priors.length;
  });
}

/**
 * Say which tax year these transactions belong to, or hand them back to the one
 * their dates fall in (`taxYear: null`).
 *
 * A sibling of `applyEnrichment` rather than another `EnrichmentField`, because
 * that function's whole shape is built around a field Akahu also writes: it
 * resolves the value against a catalog to prove the caller may name it, stamps a
 * `…Source` column so the next sync stops overwriting, and settles the conflict
 * the disagreement raised. None of that applies here. A tax year is a number, not
 * a row that could belong to another workspace; Akahu has no opinion about it, so
 * there is no source to record and nothing that could ever conflict.
 *
 * What is shared is the part that matters: the write and its log rows commit
 * together, and the log records only the rows that actually changed.
 *
 * `taxYear` is the calendar year the tax year ends in — see the schema. This does
 * not validate it: the callers are server actions that bound it against the row's
 * own date, and a bare integer has no workspace-scoped meaning to check here.
 *
 * Returns how many of the named transactions were in this workspace and therefore
 * written, on the same terms as `applyEnrichment`.
 */
export async function applyTaxYear(
  db: ScopedDb,
  transactionIds: string[],
  taxYear: number | null,
): Promise<number> {
  if (transactionIds.length === 0) return 0;

  return withScopedTx(db, async (tx) => {
    // Inside the transaction for the reason `readPriors` is: the log claims what
    // the field *was*, so it has to read the snapshot the update writes over.
    const priors = await tx.transaction.findMany({
      where: { id: { in: transactionIds } },
      select: { id: true, taxYear: true },
    });

    await tx.transaction.updateMany({
      where: { id: { in: transactionIds } },
      data: { taxYear },
    });

    // Labels, no ids: `FY2027` names a span, not a row. Null reads as a cleared
    // field in the history panel, which is what clearing the override is.
    const label = (year: number | null) => (year === null ? null : `FY${year}`);
    await recordUserChanges(
      tx,
      priors
        .filter((prior) => prior.taxYear !== taxYear)
        .map((prior) => ({
          transactionId: prior.id,
          field: "taxYear" as const,
          fromLabel: label(prior.taxYear),
          toLabel: label(taxYear),
        })),
    );

    return priors.length;
  });
}
