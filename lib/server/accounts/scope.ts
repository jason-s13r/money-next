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
 * Only balance queries need this. Transactions do not: merging a superseded
 * account moves every row onto the survivor, so the tombstone has none left to
 * contribute. That asymmetry is deliberate — see lib/server/accounts/supersede.ts
 * for why the duplication is resolved by merging rather than by filtering.
 */
export const LIVE_ACCOUNT = {
  status: "ACTIVE",
  supersededById: null,
} as const satisfies Prisma.AccountWhereInput;
