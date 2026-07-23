"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { auth } from "@/lib/server/auth";
import { authDb } from "@/lib/server/db";
import { requireUser } from "@/lib/server/auth/session";
import { IDLE, type AccountState, type ProfileState } from "./types";

/**
 * Change your own password, while signed in.
 *
 * No `requireRole`, and it is in tests/actions.test.ts's EXEMPT list alongside
 * the MFA-enrolment actions, for the same reason: "what is your role in this
 * workspace?" is the wrong question about your own credential. The right gate is
 * your *current* password, and Better Auth enforces exactly that — `changePassword`
 * refuses without it, which is what stops a borrowed unlocked laptop from
 * silently re-keying the account (the same protection `start` relies on in
 * app/enrol-mfa/actions).
 *
 * Unlike the reset flow, nothing here is a bearer link: the person is already
 * authenticated, proving both who they are (the session) and that they are not
 * merely borrowing the session (the current password). Does not redirect —
 * changing your password shouldn't move you off the page — it returns an `ok`
 * the form turns into a confirmation.
 */
export async function changePassword(_prev: AccountState, formData: FormData): Promise<AccountState> {
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");

  try {
    await auth.api.changePassword({
      headers: await headers(),
      body: {
        currentPassword,
        newPassword,
        // Sign every *other* session out. Changing a password is the move you
        // make when you think one is compromised, so leaving old sessions live
        // would defeat the point; this session keeps working (Better Auth
        // re-issues its token), the others stop on their next request.
        revokeOtherSessions: true,
      },
    });
  } catch (error) {
    // The wrong current password, and the 12-character policy on the new one,
    // both arrive here — both the user's to fix, so they belong on the page.
    if (error instanceof APIError) {
      return { error: error.body?.message ?? "Could not change your password.", ok: false };
    }
    throw error;
  }

  return { ...IDLE, ok: true };
}

/**
 * Edit your own name and email address, while signed in.
 *
 * Account-level, so `requireUser` — a session — is the gate, not `requireRole`:
 * your name and address belong to *you*, not to any one workspace, and this page
 * has no workspace in its URL to resolve (see app/account/page). It sits in
 * tests/actions.test.ts's EXEMPT list next to `changePassword` for the same
 * reason. Better Auth still re-checks the session inside both endpoints.
 *
 * The two changes go through two endpoints: `updateUser` for the name (a plain
 * column write) and `changeEmail` for the address (which owns the uniqueness
 * check and the no-verification path this instance relies on — see
 * lib/server/auth). Each is called only when its value actually changed:
 * `changeEmail` refuses a no-op with "Email is the same", and re-writing the
 * same name is wasted work. `changeEmail` is enumeration-resistant — a collision
 * with someone else's address returns success without changing anything — so a
 * clean return is not proof the address is now yours; the page re-reads it.
 */
export async function updateProfile(_prev: ProfileState, formData: FormData): Promise<ProfileState> {
  const user = await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  if (!name) return { error: "A name is required.", ok: false };
  if (!email) return { error: "An email address is required.", ok: false };

  try {
    if (name !== user.name) {
      await auth.api.updateUser({ headers: await headers(), body: { name } });
    }
    if (email !== user.email.toLowerCase()) {
      await auth.api.changeEmail({ headers: await headers(), body: { newEmail: email } });
    }
  } catch (error) {
    // A malformed address and the "same email" refusal both land here — both the
    // user's to fix, so they belong on the page.
    if (error instanceof APIError) {
      return { error: error.body?.message ?? "Could not update your details.", ok: false };
    }
    throw error;
  }

  // The header greeting and the form's own defaults are rendered from the user
  // row this request already read; revalidate so the next render reflects the
  // change rather than the stale copy.
  revalidatePath("/account");
  return { ...IDLE, ok: true };
}

/**
 * Sign one other device out, by the session's id.
 *
 * **The client sends an id, never a token.** A session token is the bearer
 * credential itself — handing another device's token to this browser would be
 * the leak the whole feature is meant to guard against — so the row is resolved
 * here, scoped to `userId`, and only its token crosses into Better Auth's
 * `revokeSession`. That scope is also the authorization: an id naming someone
 * else's session simply doesn't match, so there is nothing to revoke.
 */
export async function revokeSession(_prev: AccountState, formData: FormData): Promise<AccountState> {
  const user = await requireUser();

  const sessionId = String(formData.get("sessionId") ?? "");

  const target = await authDb.session.findFirst({
    where: { id: sessionId, userId: user.id },
    select: { token: true },
  });
  if (!target) return { error: "That session no longer exists.", ok: false };

  try {
    await auth.api.revokeSession({ headers: await headers(), body: { token: target.token } });
  } catch (error) {
    if (error instanceof APIError) {
      return { error: error.body?.message ?? "Could not sign that device out.", ok: false };
    }
    throw error;
  }

  revalidatePath("/account");
  return { ...IDLE, ok: true };
}

/**
 * Sign every *other* device out, keeping this one. The same move `changePassword`
 * makes by default (`revokeOtherSessions`), offered on its own for when the
 * password is fine but a session shouldn't be live — a shared computer left
 * logged in, say. Better Auth scopes it to the caller's own sessions.
 */
export async function revokeOtherSessions(
  _prev: AccountState,
  _formData: FormData,
): Promise<AccountState> {
  await requireUser();

  try {
    await auth.api.revokeOtherSessions({ headers: await headers() });
  } catch (error) {
    if (error instanceof APIError) {
      return { error: error.body?.message ?? "Could not sign the other devices out.", ok: false };
    }
    throw error;
  }

  revalidatePath("/account");
  return { ...IDLE, ok: true };
}
