import { redirect } from "next/navigation";

import { listWorkspaces } from "@/lib/server/auth/workspaces";
import { workspacePath } from "@/lib/workspace-path";

/**
 * `/` is a signpost, not a page.
 *
 * Every real page lives under `/w/<slug>/`, so the root's only job is to send
 * you into a workspace — the first one you belong to. There is no "default
 * workspace" concept here on purpose: with the workspace in the URL, landing
 * somewhere is a redirect, not a piece of state to keep correct.
 *
 * A signed-out visitor never reaches this: `proxy.ts` sends them to /login
 * first. A signed-in user with no memberships does, and gets told so — it means
 * an operator created their account and never gave them one.
 */
export default async function RootPage() {
  const workspaces = await listWorkspaces();
  const first = workspaces[0];

  if (first) redirect(workspacePath(first.slug, "/"));

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
