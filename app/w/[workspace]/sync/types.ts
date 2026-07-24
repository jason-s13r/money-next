// Shared types for the connect/replace-token actions. Kept out of the
// `"use server"` module because a server module may export *only* async functions
// — every export becomes a callable endpoint — and a plain object throws
// "A `use server` file can only export async functions" at module evaluation on
// the first POST, not at build. See members/types.ts, which learned it the hard
// way, and the inventory test in tests/actions.test.ts that now fences it.

/**
 * One shape for both forms. `saved` is deliberately not `connected`: the same
 * state is returned by connecting a new bank and by re-keying an existing one,
 * and the two forms say different things about it.
 */
export type ConnectBankState = { error: string | null; saved: boolean };

export const NOT_SAVED: ConnectBankState = { error: null, saved: false };
