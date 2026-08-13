import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { listWorkspaces } from "@/lib/server/auth/workspaces";
import { workspacePath } from "@/lib/workspace-path";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

/**
 * `/` is a signpost, not a page.
 *
 * Every real page lives under `/w/<slug>/`, so the root's only job is to send you
 * into a workspace. There is no "default workspace" concept here on purpose: with
 * the workspace in the URL, landing somewhere is a redirect, not a piece of state
 * to keep correct.
 *
 * Which workspace is where you last were, remembered by the proxy in the
 * `last-workspace` cookie (see proxy.ts). Before that it was whichever sorted
 * first, which for anyone in more than one workspace turned every trip out to
 * /account into a trip back into somebody else's — you left "Work" and the way
 * back put you in "Alpha".
 *
 * The cookie is a hint and is treated as one: it is looked up in the memberships
 * this user actually has, so a value that is stale (the workspace was deleted, or
 * you were removed from it) or forged falls through to the first workspace rather
 * than 404ing or leaking that a slug exists. The redirect target is always a
 * workspace the *database* says you belong to.
 *
 * A signed-out visitor never reaches this: `proxy.ts` sends them to /login first.
 * A signed-in user with no memberships does, and gets told so — it means an
 * operator created their account and never gave them one.
 */
export default async function RootPage() {
  const [workspaces, jar] = await Promise.all([listWorkspaces(), cookies()]);

  const last = jar.get("last-workspace")?.value;
  const target = workspaces.find((w) => w.slug === last) ?? workspaces[0];

  if (target) redirect(workspacePath(target.slug, "/"));

  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <h1 className="text-lg font-semibold">No workspace yet</h1>
      <p className="mt-2 text-sm opacity-70">
        Your account isn&rsquo;t a member of any workspace. Ask whoever runs this instance to
        invite you to one.
      </p>
    </main>
  );
}
