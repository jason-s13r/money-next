// What to call an account on screen.
//
// One function rather than `account.displayName ?? account.name` at each of the
// dozen sites that render an account, because the two columns mean different
// things and only one of them is ever the answer to "what is this account
// called": `name` is the provider's, rewritten on every sync, and `displayName`
// is the household's, written once by a person and never touched by ingest. A
// site that reached for `name` directly would quietly ignore a rename.
//
// Deliberately not in `lib/accounts.ts`: that module is pure balance arithmetic,
// kept isolated so the spend-down rules can be read against real bank shapes.
// This is neither balances nor server-only, so client components and the chat
// tools alike can import it.

/** The account columns the label is chosen from. */
export type NamedAccount = {
  name: string;
  displayName: string | null;
};

/**
 * The name to show for an account: the household's if they set one, otherwise
 * the provider's.
 *
 * Blank-tolerant on purpose — a `displayName` of `""` or spaces is a field
 * someone emptied, and a row rendering as nothing at all is worse than one
 * rendering as the verbose name they were trying to get away from. The action
 * that writes the column stores `null` for that case, so this is a backstop for
 * rows written any other way (a script, a direct SQL edit).
 */
export function accountLabel(account: NamedAccount): string {
  return account.displayName?.trim() || account.name;
}
