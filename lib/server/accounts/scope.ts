import type { Prisma } from "../../generated/prisma/client";

/**
 * The accounts whose balances are part of what this household has.
 *
 * Two conditions that fail in opposite directions, which is why they travel
 * together as one fragment rather than being retyped at each call site:
 *
 *   `status: "ACTIVE"` is Akahu's word — it has lost access to an INACTIVE
 *   account and the balance it last reported is stale.
 *
 *   `supersededById: null` is ours. When an institution moves to official open
 *   banking Akahu mints a new account, backfills the history under it, and then
 *   stops returning the old one *at all* — which freezes the old row's `status`
 *   at ACTIVE for good. So the provider's own signal says nothing here, and a
 *   retired account would otherwise sit in net worth forever, counting money the
 *   successor beside it is already counting.
 *
 * Only balance queries need this, and the asymmetry with transactions is
 * deliberate. A merge deletes the rows the migration re-issued, so nothing a
 * tombstone still holds exists anywhere else — those rows are history, they are
 * not double counted, and every spend, flow and budget query is right to keep
 * counting them. A *balance* is the opposite: it is one current figure the
 * successor already reports, so counting the tombstone's frozen copy of it would
 * be counting the same money twice. See lib/server/accounts/supersede.ts.
 */
export const LIVE_ACCOUNT = {
  status: "ACTIVE",
  supersededById: null,
} as const satisfies Prisma.AccountWhereInput;
