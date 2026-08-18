import "server-only";

import { cache } from "react";

import { authDb } from "../db";
import { requireWorkspace } from "./session";
import { ROLES, type Role } from "./roles";

/**
 * Who is in this workspace, and who has been asked.
 *
 * ## Why these read the database directly and the writes don't
 *
 * `Membership` and `Invite` are `CONTROL_PLANE_MODELS` — exempt from `scopedDb`,
 * because they are what *decides* tenancy rather than being scoped by it. So the
 * filter has to be written by hand here, and it is: `workspaceId` comes from
 * `requireWorkspace()`, which has already proven the caller is a member. Same
 * shape as `listWorkspaces()` next door, and the same reason it is safe.
 *
 * The writes (./members actions) go through `auth.api.*` instead, and that split
 * is deliberate. Reads are a join we want to render — Better Auth's `listMembers`
 * would give us the rows without the shape we need, and no invariant rides on a
 * read. Writes carry the invariants that are dangerous to re-derive: the
 * last-owner rule, the single-use redemption, which roles may hand out which
 * roles. A `membership.delete()` written here would be a second, divergent
 * definition of what removing a member means.
 */

export type WorkspaceMember = {
  /** `Membership.id` — what `removeMember`/`updateMemberRole` take, not the user id. */
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: Date;
};

export const listMembers = cache(async (): Promise<WorkspaceMember[]> => {
  const { workspace } = await requireWorkspace();

  const rows = await authDb.membership.findMany({
    where: { workspaceId: workspace.id },
    select: {
      id: true,
      userId: true,
      role: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
    // Name only. The role ordering is applied below, not here — see why.
    orderBy: { user: { name: "asc" } },
  });

  // Most-privileged first, then alphabetical within each role: the useful
  // ordering for a page whose question is usually "who can do what here".
  //
  // The rank comes from `ROLES` rather than the database because `role` is a
  // plain string column, so `orderBy: { role: "asc" }` sorts *alphabetically* —
  // editor, owner, viewer — which silently lists an editor above an owner. It
  // read as correct for as long as this instance happened to have no editors,
  // which is the worst way for a bug to wait. `ROLES` is the one place the
  // hierarchy is written down, and sorting a household's worth of rows in memory
  // costs nothing. The name ordering above survives because `Array.sort` is
  // stable, which is guaranteed, not incidental.
  const rank = (role: Role) => ROLES.indexOf(role);

  return rows
    .map((row) => ({
      id: row.id,
      userId: row.userId,
      name: row.user.name,
      email: row.user.email,
      role: row.role as Role,
      joinedAt: row.createdAt,
    }))
    .sort((a, b) => rank(a.role) - rank(b.role));
});

export type PendingInvite = {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
  invitedBy: string | null;
};

/**
 * Invites that are still live — pending, and not yet expired.
 *
 * Expired rows are filtered here rather than deleted anywhere: Better Auth
 * treats an expired invite as unusable regardless of its `status`, so removing
 * them would be tidying, not enforcement. Showing them would be worse than
 * useless — an owner would think a dead link still worked.
 */
export const listPendingInvites = cache(async (): Promise<PendingInvite[]> => {
  const { workspace } = await requireWorkspace();

  const rows = await authDb.invite.findMany({
    where: {
      workspaceId: workspace.id,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      email: true,
      role: true,
      expiresAt: true,
      invitedBy: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role as Role,
    expiresAt: row.expiresAt,
    invitedBy: row.invitedBy?.name ?? null,
  }));
});
