// Shared types and constants for the members actions. Kept out of the
// `"use server"` module for the reason rules/types.ts already documents: a server
// module may export *only* async functions, because every export becomes a
// callable endpoint. `NO_ERROR` is a plain object, so exporting it from
// actions.ts threw "A `use server` file can only export async functions, found
// object" — at module-evaluation time, on the first POST, not at build.

export type MemberActionState = { error: string | null };

export const NO_ERROR: MemberActionState = { error: null };

/**
 * The result of generating a reset link. `token` is the freshly minted reset
 * token on success, which the client turns into a link to copy (see
 * ./reset-link) — the token itself never becomes a URL on the server, so a
 * misconfigured `BETTER_AUTH_URL` can't produce a link that copies cleanly and
 * fails in someone else's chat window, the same reasoning as ./invite-link.
 */
export type ResetLinkState = { error: string | null; token: string | null };

export const NO_RESET: ResetLinkState = { error: null, token: null };
