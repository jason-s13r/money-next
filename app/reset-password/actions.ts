"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/server/auth";
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
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");

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
    // Covers the expired/used/unknown token (INVALID_TOKEN) and the 12-character
    // policy — both the user's to act on, so they belong on the page.
    if (error instanceof APIError) {
      return { error: error.body?.message ?? "Could not reset your password." };
    }
    throw error;
  }

  // Outside the try: `redirect` works by throwing, and catching it here would
  // turn a successful reset into an error message. There is no session yet —
  // resetting a password does not sign you in — so this lands on the login form,
  // where the new password is the thing to try.
  redirect("/login");
}
