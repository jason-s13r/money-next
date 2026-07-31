"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/server/auth";
import { authDb } from "@/lib/server/db";
import { getSession } from "@/lib/server/auth/session";
import { apiErrorMessage, raw, text } from "@/lib/form-data";
import { workspacePath } from "@/lib/workspace-path";
import type { InviteState } from "./types";

/**
 * Accepting an invitation, in the two shapes it arrives in.
 *
 * Neither action opens with `requireRole`, and they are the only mutating
 * actions in the app that don't — which is why tests/actions.test.ts names them
 * explicitly rather than letting the inventory rule bend. The reason is
 * structural: `requireRole` asks what your role is *in a workspace you are
 * already in*, and the entire point here is that you are not in one yet. The
 * invite row is the authority instead, and both actions re-read it server-side
 * rather than trusting a hidden field to still describe reality.
 */

/**
 * The invite, re-checked at the moment of use.
 *
 * The page checked all of this to decide what to render, and that check is worth
 * nothing here: a page render and a form POST are different requests, and in
 * between, the invite can be cancelled, expire, or be accepted by the same link
 * opened in another tab. This is the check that counts.
 */
async function liveInvite(id: string) {
  const invite = await authDb.invite.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      status: true,
      expiresAt: true,
      workspace: { select: { slug: true } },
    },
  });

  if (!invite || invite.status !== "pending" || invite.expiresAt <= new Date()) return null;
  return invite;
}

/**
 * Create the account this invite was addressed to.
 *
 * **The email comes from the invite row, never from the form.** That is the one
 * line in this file that matters: it is what stops a forwarded link from being
 * redirected to an attacker's address, and it means the worst a link-holder can
 * do is create the account the owner already decided to create, at the address
 * the owner already typed. See the page for the honest accounting of that
 * bearer window.
 *
 * Does not accept the invitation — it redirects back to the page, now with a
 * session, and the invitee presses Join. Two requests rather than one on
 * purpose: `acceptInvitation` authorises against the *session*, and the session
 * this action just minted exists only as a `Set-Cookie` on the way out. Calling
 * accept here would have to authorise against something other than the cookie,
 * and inventing a second way to prove who you are — for the one flow where
 * nobody is proven yet — is how this kind of code goes wrong.
 */
export async function signUpFromInvite(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const id = text(formData, "inviteId");
  const name = text(formData, "name");
  // `raw`: the password is hashed as typed, so trimming here would create an
  // account whose stored hash does not match what the user thinks they chose.
  const password = raw(formData, "password");

  const invite = await liveInvite(id);
  if (!invite) return { error: "This invitation isn't valid any more." };

  if (!name) return { error: "A name is required." };

  try {
    await auth.api.signUpEmail({
      headers: await headers(),
      body: { email: invite.email, name, password },
    });
  } catch (error) {
    return { error: apiErrorMessage(error, "Could not create your account.") };
  }

  // Outside the try: `redirect` works by throwing, and a redirect swallowed by
  // an error handler is a bug that looks like a hang.
  redirect(`/invite/${id}`);
}

/** Redeem the invitation. Single-use and atomic — Better Auth owns both. */
export async function acceptInvite(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const id = text(formData, "inviteId");

  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/invite/${id}`)}`);

  const invite = await liveInvite(id);
  if (!invite) return { error: "This invitation isn't valid any more." };

  try {
    await auth.api.acceptInvitation({
      headers: await headers(),
      body: { invitationId: id },
    });
  } catch (error) {
    return { error: apiErrorMessage(error, "Could not accept this invitation.") };
  }

  redirect(workspacePath(invite.workspace.slug, "/"));
}
