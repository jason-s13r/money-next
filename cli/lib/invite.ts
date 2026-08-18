/**
 * Inviting someone from the shell.
 *
 * Not `auth.api.createInvitation`: it resolves the *caller's* membership to
 * check `invitation: ["create"]`, so unlike `createOrganization` and `addMember`
 * it has no sessionless mode. This drops to `getOrgAdapter`, a public export and
 * what the endpoints are built on. Same row; what is given up is the permission
 * check (the authority here is shell access) and `sendInvitationEmail`.
 *
 * `invitedByUserId` stays null: the operator is often in no workspace, and with
 * `--invite-owner` nobody is. Naming one would invent an inviter.
 */
import type { User } from "better-auth";

import type { Role } from "../../lib/server/auth/roles";

type Workspace = { id: string; name: string; slug: string };

/** Also used directly by `workspace create --invite-owner`, which has no members yet. */
export async function orgAdapter() {
  const { auth, organizationOptions } = await import("../../lib/server/auth");
  const { getOrgAdapter } = await import("better-auth/plugins/organization");

  // Variance wart in the library's types: `auth.$context` is typed against this
  // instance's exact options, `getOrgAdapter` wants the general `AuthContext`,
  // and `DBAdapter` is invariant. Same object the endpoints receive.
  type Context = Parameters<typeof getOrgAdapter>[0];
  return getOrgAdapter((await auth.$context) as unknown as Context, organizationOptions);
}

export type SentInvite = {
  id: string;
  url: string;
  /** True when this re-sent an invitation that was already outstanding. */
  resent: boolean;
  /** False when SMTP is unconfigured, so the link is the operator's to deliver. */
  queued: boolean;
};

/**
 * Create an invitation and queue its email, or re-send one already outstanding.
 *
 * A live invitation is re-sent rather than refused — running the command twice
 * usually means the first message did not arrive. The caller is told, since the
 * expiry still runs from the first attempt. A lapsed one is superseded.
 */
export async function sendInvite(args: {
  workspace: Workspace;
  email: string;
  role: Role;
  /** Pre-fills the signup form. A convenience, never a control. */
  name?: string;
}): Promise<SentInvite> {
  const { authDb } = await import("../../lib/server/db");
  const { emailEnabled } = await import("../../lib/server/email/config");
  const { inviteMessage, inviteUrl } = await import("../../lib/server/email/messages");
  const { enqueueEmail } = await import("../../lib/server/email/outbox");

  // The endpoint lowercases before storing, so matching it is what makes "is
  // one already outstanding" the same question the app asks.
  const email = args.email.toLowerCase();

  const message = (inviteId: string) =>
    inviteMessage({
      to: email,
      workspaceName: args.workspace.name,
      inviterName: null,
      inviteId,
    });

  const pending = await authDb.invite.findMany({
    where: { workspaceId: args.workspace.id, email, status: "pending" },
    select: { id: true, expiresAt: true },
  });

  const live = pending.find((invite) => invite.expiresAt > new Date());
  if (live) {
    await enqueueEmail(message(live.id));
    return { id: live.id, url: inviteUrl(live.id), resent: true, queued: emailEnabled() };
  }

  // `pending` with a date in the past describes nothing.
  if (pending.length > 0) {
    await authDb.invite.updateMany({
      where: { id: { in: pending.map((invite) => invite.id) } },
      data: { status: "canceled" },
    });
  }

  const adapter = await orgAdapter();

  const invite = await adapter.createInvitation({
    invitation: {
      email,
      role: args.role,
      organizationId: args.workspace.id,
      // Dereferenced unconditionally by the adapter. With teams off the plugin
      // declares no `teamId`, so the derived value is dropped before Prisma.
      teamIds: [],
      // Overrides the `inviterId: user.id` seeded below — `invitation` spreads
      // last.
      inviterId: null,
    },
    user: NO_INVITER,
  });

  // The adapter copies only fields the plugin declares, and `name` is not one.
  if (args.name) {
    await authDb.invite.update({ where: { id: invite.id }, data: { name: args.name } });
  }

  await enqueueEmail(message(invite.id));

  return { id: invite.id, url: inviteUrl(invite.id), resent: false, queued: emailEnabled() };
}

/**
 * `createInvitation` demands a `user` and reads only `user.id`, which the
 * explicit `inviterId` above overwrites. `id: null` keeps that literal, so a
 * future version reading more off this fails loudly rather than attributing the
 * invite to someone invented.
 */
const NO_INVITER = { id: null } as unknown as User;
