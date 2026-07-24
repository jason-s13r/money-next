/**
 * Putting a person into a workspace, shared by the scripts that do it.
 *
 * Two callers: `user:create --workspace` (mint an account and place it in one
 * step) and `workspace:member` (place an account that already exists). They ask
 * the same two questions — which workspace is `<slug|id>`, and is this person
 * already in it — and the answers have to match, so they are written once. Same
 * reason `read-secret.ts` exists.
 *
 * Imports are dynamic, and that is not incidental. `lib/server/auth` builds its
 * client at module scope and throws without `BETTER_AUTH_SECRET`, so any script
 * that statically imports a module reaching it can no longer answer `--help` on
 * a machine that has not been configured — which is precisely the machine whose
 * operator is reading `--help`. Dynamic imports are cached, so the second call
 * costs nothing.
 */
import type { Role } from "../lib/server/auth/roles";

/**
 * Find a workspace by slug or id.
 *
 * Both, because the two identifiers are used by different readers: a person has
 * seen the slug (it is in the URL they visit), and a log line, an error message
 * or `workspace:list` prints the id. Requiring the caller to know which one they
 * are holding is a papercut with no upside — the two namespaces cannot collide,
 * since a slug is validated to be lowercase-hyphenated and an id is not.
 */
export async function resolveWorkspace(ref: string) {
  const { authDb } = await import("../lib/server/db");

  const workspace = await authDb.workspace.findFirst({
    where: { OR: [{ slug: ref }, { id: ref }] },
    select: { id: true, slug: true, name: true },
  });

  if (!workspace) {
    throw new Error(`No workspace with slug or id "${ref}". See: pnpm workspace:list`);
  }

  return workspace;
}

/** Whether this person is already in this workspace, and as what. */
export async function currentRole(workspaceId: string, userId: string) {
  const { authDb } = await import("../lib/server/db");

  const membership = await authDb.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });

  return membership?.role ?? null;
}

/**
 * Add a membership.
 *
 * Through Better Auth's `addMember` rather than an insert, for the reason
 * `user:create` signs up rather than writing a `User` row: the organization
 * plugin owns what a membership is, including the hooks deferred quotas will
 * land in. `addMember` is declared `serverOnly` and takes an explicit `userId`,
 * which is the sanctioned way to say "there is no session here".
 *
 * Its siblings `removeMember` and `updateMemberRole` are *not* server-only —
 * both read `session.user.id` to decide permissions, and both enforce that a
 * workspace never loses its last owner. So removal and demotion are not
 * available out here and deliberately have no CLI: reaching past those endpoints
 * would mean writing a second copy of the last-owner invariant, and the copy
 * that drifts is always the one in the script nobody reads. They live at
 * `/w/<slug>/members`, where an owner is signed in and the library is enforcing.
 */
export async function addMembership(args: {
  workspaceId: string;
  userId: string;
  role: Role;
}) {
  const { auth } = await import("../lib/server/auth");

  await auth.api.addMember({
    body: { userId: args.userId, organizationId: args.workspaceId, role: args.role },
  });
}
