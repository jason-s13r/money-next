// Shared types and constants for the members actions. Kept out of the
// `"use server"` module for the reason rules/types.ts already documents: a server
// module may export *only* async functions, because every export becomes a
// callable endpoint. `NO_ERROR` is a plain object, so exporting it from
// actions.ts threw "A `use server` file can only export async functions, found
// object" — at module-evaluation time, on the first POST, not at build.

export type MemberActionState = { error: string | null };

export const NO_ERROR: MemberActionState = { error: null };
