"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { applyTaxYear } from "@/lib/server/enrichment";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { taxYearFor } from "@/lib/server/tax-year";
import { taxYearChoices } from "@/lib/periods";

// Which tax year one transaction is relevant to, when that is not the year its
// date falls in — a terminal tax payment or a refund settling a year that has
// already closed. See `Transaction.taxYear` in the schema.
//
// `enrichment: ["update"]` rather than a statement of its own: this is exactly
// what that one describes, something a person can change about a row the bank
// told us about. Moving the *workspace's* year boundary is the wider decision and
// is owner-only, over in the settings action.

/**
 * Set the override, or clear it back to the transaction's own date (`null`).
 *
 * `year` is the picker's option value, so a string — the shape it has on the wire
 * — and parsing it is part of validating it rather than something the caller is
 * trusted to have done. `null` is the picker's clear row.
 *
 * The year is then checked against `taxYearChoices` for this row rather than taken
 * on trust. The picker offers the same list, so a legitimate caller can never trip
 * this — which is the point: a server action is a public POST endpoint and the
 * option set rendered in the page is not a control (T9). An unbounded integer here
 * would let a stray value park a transaction in a tax year no view ever shows,
 * where it would go missing from every total without appearing anywhere else.
 */
export async function setTransactionTaxYear(transactionId: string, year: string | null) {
  await requireRole({ enrichment: ["update"] });

  const db = await getDb();

  // Read through the scoped client, so an id from another workspace is simply not
  // found and the error below is the honest answer for both cases.
  const tx = await db.transaction.findUnique({
    where: { id: transactionId },
    select: { date: true },
  });
  if (!tx) throw new Error(`Unknown transaction: ${transactionId}`);

  const taxYear = year === null ? null : Number(year);
  if (taxYear !== null && !taxYearChoices(tx.date, await taxYearFor(db)).includes(taxYear)) {
    throw new Error(`"${year}" is not a tax year this transaction can be moved to.`);
  }

  await applyTaxYear(db, [transactionId], taxYear);

  await revalidateWorkspacePath(`/transactions/${transactionId}`);
}
