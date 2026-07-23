"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";

import { auth } from "@/lib/server/auth";
import { authDb } from "@/lib/server/db";
import { requireRole } from "@/lib/server/auth/session";
import { isRole } from "@/lib/server/auth/roles";
import { withResetTokenCapture } from "@/lib/server/auth/reset-capture";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { NO_ERROR, type MemberActionState, type ResetLinkState } from "./types";

/**
 * Member management: the owner-facing surface T12 asked for and phase 3 didn't
 * build.
 *
 * Every action here is a public POST endpoint that changes who can read a
 * household's entire financial history, so each opens with `requireRole` — the
 * same rule as every other action in this app, and the reason the inventory test
 * in tests/actions.test.ts exists.
 *
 * That check is deliberately **not** the only one. Better Auth re-checks the
 * caller's permission inside each endpoint, against the workspace it resolves
 * itself, and that redundancy is doing real work rather than being belt and
 * braces: `requireRole` answers for *the workspace in the URL*, while the
 * library answers for *the workspace the target row actually belongs to*. Those
 * are the same workspace only when the id in the form is honest, and a form
 * field is never honest by assumption. `cancelInvitation` is the sharp example —
 * it takes no workspace id at all, resolving one from the invite and demanding
 * the caller be an owner *there*, so an owner of A cannot cancel B's invite even
 * though `requireRole` passed for A.
 */

/**
 * Turn Better Auth's thrown `APIError` into something to render.
 *
 * These are not all developer errors — most are the invariants the plan asked
 * for, arriving as the user hits them: the last owner trying to demote
 * themselves, an email that is already a member, an invite that was accepted
 * while the page sat open. They belong on the page in prose, not in a stack
 * trace, so the owner learns *why* the workspace refused.
 */
async function run(action: () => Promise<unknown>): Promise<MemberActionState> {
  try {
    await action();
  } catch (error) {
    if (error instanceof APIError) {
      return { error: error.body?.message ?? "That didn't work." };
    }
    throw error;
  }

  await revalidateWorkspacePath("/members");
  return NO_ERROR;
}

/** Invite someone by email. Owner-only, and the role is checked, not trusted. */
export async function invite(
  _prev: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  const ctx = await requireRole({ invitation: ["create"] });

  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  // A select renders three options; a POST can carry any string. Better Auth
  // rejects an unknown role too, but this app's own vocabulary is the thing
  // being asserted here, and `isRole` is where it is written down.
  if (!isRole(role)) return { error: "Pick a role." };
  if (!email) return { error: "An email address is required." };

  return run(async () => {
    const invitation = await auth.api.createInvitation({
      headers: await headers(),
      // Explicit, never the session's active organization: this app's active
      // workspace is the URL, and `ctx` is what proved the caller is in it.
      body: { email, role, organizationId: ctx.workspace.id },
    });

    // The name isn't part of Better Auth's invitation schema, so it goes on in a
    // second write against the row it just created. Only when one was typed —
    // an empty name would overwrite nothing and means the same as never set.
    if (name) {
      await authDb.invite.update({ where: { id: invitation.id }, data: { name } });
    }
  });
}

/** Withdraw a pending invite, so the link stops working. */
export async function cancelInvite(
  _prev: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  await requireRole({ invitation: ["cancel"] });

  const invitationId = String(formData.get("invitationId") ?? "");

  return run(async () =>
    auth.api.cancelInvitation({
      headers: await headers(),
      body: { invitationId },
    }),
  );
}

/**
 * Remove a member. Their access ends on their next request, not on their next
 * login — `requireWorkspace()` re-reads the membership every time (T11), so
 * there is no session to sweep.
 */
export async function removeMember(
  _prev: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  const ctx = await requireRole({ member: ["delete"] });

  const memberIdOrEmail = String(formData.get("memberId") ?? "");

  return run(async () =>
    auth.api.removeMember({
      headers: await headers(),
      body: { memberIdOrEmail, organizationId: ctx.workspace.id },
    }),
  );
}

/**
 * Change a member's role.
 *
 * The last-owner invariant lives inside this call rather than in a check above
 * it, which is the right place for it: Better Auth refuses to demote the final
 * owner, and refuses to let a non-owner hand out ownership. Re-implementing
 * either here would mean two rules that have to agree forever.
 */
export async function changeRole(
  _prev: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  const ctx = await requireRole({ member: ["update"] });

  const memberId = String(formData.get("memberId") ?? "");
  const role = String(formData.get("role") ?? "");

  if (!isRole(role)) return { error: "Pick a role." };

  return run(async () =>
    auth.api.updateMemberRole({
      headers: await headers(),
      body: { memberId, role, organizationId: ctx.workspace.id },
    }),
  );
}

/**
 * Generate a password-reset link for a member who's locked out.
 *
 * Gated on `member: ["update"]` — owner-only, the same power that already lets
 * an owner change roles and remove people. This one is heavier than it looks:
 * the link is a bearer credential (see app/reset-password and the invite page's
 * honest note), so an owner who generates it can set that member's password
 * before ever sending it. That is a real account-takeover capability, and it is
 * deliberately reserved to the role that can already end a member's access
 * entirely. Nothing an editor or viewer can reach.
 *
 * **The target is resolved by id against this workspace, and the email is read
 * from the row — never from the form.** A `userId` field can name anyone; the
 * membership lookup is what proves the id belongs to a member *here*, so an
 * owner of one workspace cannot mint a reset link for a stranger, or for a
 * member of a workspace they don't own. Same rule as `removeMember` and the
 * invite flow: the id is an identifier, the database is the authority.
 *
 * Returns the token rather than revalidating: nothing on the page changed (no
 * reset row is listed anywhere), and the client needs the token to build the
 * link. Better Auth still owns the token's generation, expiry, and single-use
 * redemption — `requestPasswordReset` mints it and `captureResetToken` is the
 * only reason we ever see it (lib/server/auth/reset-capture).
 */
export async function generateResetLink(
  _prev: ResetLinkState,
  formData: FormData,
): Promise<ResetLinkState> {
  const ctx = await requireRole({ member: ["update"] });

  const userId = String(formData.get("userId") ?? "");

  const membership = await authDb.membership.findFirst({
    where: { workspaceId: ctx.workspace.id, userId },
    select: { user: { select: { email: true } } },
  });
  if (!membership) return { error: "That person isn't a member of this workspace.", token: null };

  try {
    const requestHeaders = await headers();
    const token = await withResetTokenCapture(() =>
      auth.api.requestPasswordReset({
        headers: requestHeaders,
        // The member's own address, from the row above. A reset link is only
        // ever for the account it names.
        body: { email: membership.user.email },
      }),
    );

    // `requestPasswordReset` is enumeration-resistant and swallows failures, so a
    // null token means it produced none — here, only if reset were misconfigured
    // (it isn't) or the row vanished between the two queries. Say so plainly
    // rather than hand back a link that goes nowhere.
    if (!token) return { error: "Couldn't generate a link. Try again.", token: null };

    return { error: null, token };
  } catch (error) {
    if (error instanceof APIError) {
      return { error: error.body?.message ?? "Couldn't generate a link.", token: null };
    }
    throw error;
  }
}
