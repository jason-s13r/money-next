"use server";

import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { requireRole } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { accountLabel } from "@/lib/account-name";
import { ACCOUNT_NAME_MAX_LENGTH, type RenameAccountResult } from "./types";

// The one thing a person can change about an account. Everything else on the
// record is Akahu's and is rewritten on every sync (see `syncAccounts`).

/**
 * Give an account the name this household calls it, or clear it back to the
 * provider's.
 *
 * An empty field means "no override" and stores `null` rather than `""`: the two
 * would render identically through `accountLabel`, and a column with both in it
 * invites a future reader to test the wrong one. Trimmed for the same reason a
 * label name is — a trailing space is a typo in this field, not content.
 *
 * A rename that changes nothing still returns `ok`. The form's Save is allowed to
 * be a no-op; reporting "nothing changed" as a failure would be a lie about a
 * write that did exactly what was asked.
 */
export async function renameAccount(
  accountId: string,
  displayName: string,
): Promise<RenameAccountResult> {
  await requireRole({ account: ["update"] });

  const trimmed = displayName.trim();
  if (trimmed.length > ACCOUNT_NAME_MAX_LENGTH) {
    return { ok: false, reason: `Keep it under ${ACCOUNT_NAME_MAX_LENGTH} characters.` };
  }

  // Scoped client, so `updateMany` can only ever reach this workspace's rows — and
  // a `count` of 0 means the id names another workspace's account or none at all.
  // `updateMany` rather than `update` precisely because it does not throw on a
  // miss: the id came off a URL, and "no such account here" is a 404-shaped fact
  // to report, not a server fault to log.
  const db = await getDb();
  const { count } = await db.account.updateMany({
    where: { id: accountId },
    data: { displayName: trimmed || null },
  });
  if (count === 0) return { ok: false, reason: "That account no longer exists." };

  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { name: true, displayName: true },
  });

  // The account's own page and the listing it links from. An account name also
  // appears on every transaction listing and in the dashboard's transfer
  // summaries, which no path-based revalidation can enumerate — harmless today,
  // since every read awaits `connection()` and so nothing is cached to go stale
  // (see `revalidateWorkspacePath`), and the same limit every other action here
  // lives with.
  await revalidateWorkspacePath(`/accounts/${accountId}`);
  await revalidateWorkspacePath("/accounts");

  return {
    ok: true,
    displayName: account?.displayName ?? null,
    label: account ? accountLabel(account) : trimmed,
  };
}
