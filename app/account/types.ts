// Shared types for the account actions. Kept out of the `"use server"` module
// because every export there becomes a callable endpoint — see
// tests/actions.test.ts and app/invite/[id]/types.ts.

export type AccountState = { error: string | null; ok: boolean };

export const IDLE: AccountState = { error: null, ok: false };

// Profile (name + email) and session revocation both report the same
// error-or-ok shape the password form does, so they share it.
export type ProfileState = AccountState;

export const PROFILE_IDLE: ProfileState = IDLE;
