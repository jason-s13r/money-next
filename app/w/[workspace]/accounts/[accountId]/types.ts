// Shared types and bounds for the account actions. Kept out of the `"use server"`
// module so the rename form can import them without pulling a server action into
// its bundle (and so the action file exports only async functions, as required).

/**
 * How long a display name may be. Longer than any provider's own name and far
 * longer than anything worth typing — a bound so a paste of a whole document
 * can't become a table column.
 *
 * Shared with the form so the field stops typing where the action would refuse,
 * rather than accepting a paste and rejecting it after the fact. The action still
 * checks it: the input's `maxLength` is a courtesy, and a server action is a
 * public POST endpoint.
 */
export const ACCOUNT_NAME_MAX_LENGTH = 80;

/**
 * What the rename form gets back from a save. The label is the point of returning
 * anything: clearing the field falls back to the provider's name, so the form has
 * to be told what the account is now called rather than assuming it kept what was
 * typed.
 */
export type RenameAccountResult =
  | { ok: false; reason: string }
  | { ok: true; displayName: string | null; label: string };
