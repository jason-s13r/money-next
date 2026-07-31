"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/server/auth";
import { apiErrorMessage, raw } from "@/lib/form-data";
import { type ResetState } from "./types";

/**
 * Set a new password from a reset link.
 *
 * No `requireRole`, and it is in tests/actions.test.ts's EXEMPT list for the
 * same reason the invite actions are: the whole point is that the caller is
 * *not* in a workspace and may not even be able to sign in. The reset token is
 * the authority here — a bearer credential an owner generated (see
 * app/w/[workspace]/members) or the account holder requested. Better Auth owns
 * everything that makes it safe: the token is single-use (consumed on success),
 * time-limited (1 hour, per lib/server/auth), and validated server-side here,
 * not at the page that rendered the form.
 *
 * The token rides a hidden field rather than the URL of *this* POST, but it
 * arrived in the link's query string, so it is exactly as sensitive as the link
 * — which is the point of keeping the link short-lived and single-use.
 */
export async function resetPassword(_prev: ResetState, formData: FormData): Promise<ResetState> {
  // Both `raw`: the token is a credential compared byte-for-byte, and the
  // password is hashed as typed. Neither is a field to tidy up on the way past.
  const token = raw(formData, "token");
  const password = raw(formData, "password");

  if (!token) {
    // A form with no token can't reset anything — this is the link-was-mangled
    // case, worth its own message rather than Better Auth's generic one.
    return { error: "This reset link is missing its token. Ask for a new link." };
  }

  try {
    await auth.api.resetPassword({
      headers: await headers(),
      body: { token, newPassword: password },
    });
  } catch (error) {
    return { error: apiErrorMessage(error, "Could not reset your password.") };
  }

  // Outside the try: `redirect` works by throwing, and catching it here would
  // turn a successful reset into an error message. There is no session yet —
  // resetting a password does not sign you in — so this lands on the login form,
  // where the new password is the thing to try.
  redirect("/login");
}
