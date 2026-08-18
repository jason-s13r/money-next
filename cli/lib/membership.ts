/**
 * Putting a person into a workspace. Two callers — `money user create
 * --workspace` and `money workspace add-member` — ask the same two questions,
 * and the answers have to match, so they are written once.
 *
 * Imports are dynamic for the reason in cli/program.ts: a static one would make
 * `--help` fail unconfigured. They are cached, so the second call costs nothing.
 */
import type { Role } from "../../lib/server/auth/roles";

/**
 * Find a workspace by slug or id. Both, because a person has seen the slug (it
 * is in the URL) and logs print the id. The namespaces cannot collide — a slug
 * is validated lowercase-hyphenated and an id is not.
 */
export async function resolveWorkspace(ref: string) {
  const { authDb } = await import("../../lib/server/db");

  const workspace = await authDb.workspace.findFirst({
    where: { OR: [{ slug: ref }, { id: ref }] },
    select: { id: true, slug: true, name: true },
  });

  if (!workspace) {
    throw new Error(`No workspace with slug or id "${ref}". See: money workspace list`);
  }

  return workspace;
}

/** Whether this person is already in this workspace, and as what. */
export async function currentRole(workspaceId: string, userId: string) {
  const { authDb } = await import("../../lib/server/db");

  const membership = await authDb.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });

  return membership?.role ?? null;
}

/**
 * Add a membership through Better Auth's `addMember` rather than an insert: the
 * organization plugin owns what a membership is. `addMember` is `serverOnly` and
 * takes an explicit `userId` — the sanctioned way to say "no session here".
 *
 * Removal and demotion deliberately have no CLI. `removeMember` and
 * `updateMemberRole` read `session.user.id` and enforce the last-owner rule, so
 * reaching past them would mean a second copy of that invariant — and the copy
 * that drifts is the one nobody reads. They live at `/w/<slug>/members`.
 */
export async function addMembership(args: {
  workspaceId: string;
  userId: string;
  role: Role;
}) {
  const { auth } = await import("../../lib/server/auth");

  await auth.api.addMember({
    body: { userId: args.userId, organizationId: args.workspaceId, role: args.role },
  });
}
