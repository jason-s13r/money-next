// Shared types and constants for the invite actions. Kept out of the
// `"use server"` module for the same reason as members/types.ts and
// rules/types.ts: a server module may export only async functions, since every
// export becomes a callable endpoint.

export type InviteState = { error: string | null };

export const NO_ERROR: InviteState = { error: null };
