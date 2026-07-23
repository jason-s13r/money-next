// Shared types for the reset-password action. Kept out of the `"use server"`
// module because every export of a server module becomes a callable endpoint,
// so a plain value or type export throws at runtime — see
// tests/actions.test.ts and app/invite/[id]/types.ts.

export type ResetState = { error: string | null };

export const NO_ERROR: ResetState = { error: null };
