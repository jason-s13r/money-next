import "server-only";

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { auth } from ".";
import { authDb } from "../db";
import type { Role } from "./roles";
import type { statements } from "./roles";

/**
 * Who is asking, and which workspace they are asking about.
 *
 * This is the authorization layer the Next.js auth guide points at: real checks
 * live close to the data, and `proxy.ts` only does optimistic redirects. Every
 * page and every server action reaches the database through `getDb()`, and
 * `getDb()` goes through here — so there is one answer to "may you see this",
 * in one place, for ~132 call sites.
 */

/**
 * The header `proxy.ts` copies the `[workspace]` URL segment into.
 *
 * Why a header rather than the route param: server actions never receive route
 * params. A page can read `params.workspace`, but the POST that a form fires
 * cannot — so a params-based design would mean binding the workspace into all
 * ~30 actions by hand and trusting that the next one written remembers. Both a
 * page and its actions POST to the same `/w/<slug>/…` URL, so the proxy can
 * read the slug off the path for both, and neither has to think about it.
 *
 * **This header is untrusted input, and that is fine.** A client can forge it;
 * the proxy overwrites it on every request anyway, and even if it got through,
 * it only *names* a workspace. Naming one you are not a member of gets you a
 * 404 from `requireWorkspace` below. The header is an identifier, not a
 * capability — the same rule the ids follow (threat-model.md, standing rule 4).
 */
export const WORKSPACE_SLUG_HEADER = "x-workspace-slug";

/**
 * The current session, or null. Memoised per request: a page that checks the
 * user and then reads data through `getDb()` would otherwise validate the same
 * cookie twice.
 */
export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

/** The signed-in user, or a redirect to the login page. */
export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");

  // MFA is a capability that ships now and an obligation only when the operator
  // says so (docs/multi-user.md). Off, a user who wants TOTP can still enable
  // it. On, an unenrolled session is walked to enrolment before it reaches any
  // financial data — which is the posture Akahu's accreditation requires,
  // reachable by flipping a flag rather than by migrating people.
  if (requireMfa() && !session.user.twoFactorEnabled) redirect("/enrol-mfa");

  return session.user;
}

export function requireMfa() {
  return process.env.REQUIRE_MFA === "true";
}

export type WorkspaceContext = {
  user: Awaited<ReturnType<typeof requireUser>>;
  workspace: { id: string; slug: string; name: string };
  role: Role;
};

/**
 * The current workspace, proven to be one this user is actually in.
 *
 * The membership is read from the database on **every** request rather than
 * trusted from the session cookie. That is the whole answer to two threats at
 * once: a revoked member's live session stops working on their next request
 * (T11), and a session cannot be pointed at a workspace it was never granted
 * (T8). It costs one indexed lookup, memoised per request.
 *
 * A workspace you are not a member of is a 404, never a 403 — "when in doubt at
 * a boundary, 404" (threat-model.md, standing rule 6). A 403 would confirm the
 * workspace exists, which is itself something an outsider should not learn.
 */
export const requireWorkspace = cache(async (): Promise<WorkspaceContext> => {
  const user = await requireUser();

  const slug = (await headers()).get(WORKSPACE_SLUG_HEADER);
  if (!slug) notFound();

  const membership = await authDb.membership.findFirst({
    where: { userId: user.id, workspace: { slug } },
    select: { role: true, workspace: { select: { id: true, slug: true, name: true } } },
  });
  if (!membership) notFound();

  return { user, workspace: membership.workspace, role: membership.role as Role };
});

type Statements = typeof statements;
type Permissions = Partial<{ [K in keyof Statements]: Statements[K][number][] }>;

/**
 * Thrown when a member of the workspace asks for something their role does not
 * allow. Distinct from "not a member", which is a 404 and never reaches here.
 *
 * Deliberately not Next's `forbidden()`: that needs
 * `experimental.authInterrupts`, and an experimental API whose semantics may
 * change is a poor foundation for the check that stands between a viewer and a
 * write. This throws instead — a server action has no 403 page to render
 * anyway, and an uncaught throw fails closed.
 */
export class ForbiddenError extends Error {
  /**
   * A stable digest, so `app/w/[workspace]/error.tsx` can tell a refusal from a
   * genuine fault and say the useful thing instead of "something went wrong".
   *
   * This is the only channel that survives the trip. In production Next strips a
   * server error's `message` before it reaches the browser — deliberately, since
   * messages leak internals — and replaces it with a generated digest, so the
   * class, the name and the text are all gone by the time the boundary sees it.
   * An error that arrives carrying its own `digest` keeps it, which turns this
   * into a deliberate, one-word thing we are choosing to tell the client.
   *
   * Safe to expose: it says a rule refused you, which the person already knows,
   * and not which rule or what would have satisfied it. The permissions stay in
   * `message` for the server log.
   */
  readonly digest = "FORBIDDEN";

  constructor(permissions: Permissions) {
    super(`Forbidden: this role may not ${JSON.stringify(permissions)}`);
    this.name = "ForbiddenError";
  }
}

/**
 * Assert the current user may do this, in the current workspace.
 *
 * Every mutating server action opens with one of these. Hiding a button is not a
 * control — a server action is a public POST endpoint, callable by anyone with
 * a session regardless of what the UI chose to render (T9).
 *
 * Delegates the actual decision to Better Auth's access control so the roles
 * stay declarative (see ./roles), and passes `organizationId` explicitly rather
 * than letting it default to the session's active organization — this app's
 * active workspace is the URL, and the session's copy is not read.
 */
export async function requireRole(permissions: Permissions): Promise<WorkspaceContext> {
  const ctx = await requireWorkspace();

  const { success } = await auth.api.hasPermission({
    headers: await headers(),
    body: { organizationId: ctx.workspace.id, permissions: permissions as never },
  });
  if (!success) throw new ForbiddenError(permissions);

  return ctx;
}
