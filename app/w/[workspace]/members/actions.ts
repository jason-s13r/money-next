"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";

import { auth } from "@/lib/server/auth";
import { requireRole } from "@/lib/server/auth/session";
import { isRole } from "@/lib/server/auth/roles";
import { revalidateWorkspacePath } from "@/lib/server/workspace";
import { NO_ERROR, type MemberActionState } from "./types";

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

  // A select renders three options; a POST can carry any string. Better Auth
  // rejects an unknown role too, but this app's own vocabulary is the thing
  // being asserted here, and `isRole` is where it is written down.
  if (!isRole(role)) return { error: "Pick a role." };
  if (!email) return { error: "An email address is required." };

  return run(async () =>
    auth.api.createInvitation({
      headers: await headers(),
      // Explicit, never the session's active organization: this app's active
      // workspace is the URL, and `ctx` is what proved the caller is in it.
      body: { email, role, organizationId: ctx.workspace.id },
    }),
  );
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
