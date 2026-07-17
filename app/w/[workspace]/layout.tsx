import { SiteNav } from "@/ui/chrome/site-nav";
import { WorkspaceProvider } from "@/ui/chrome/workspace-context";
import { requireWorkspace } from "@/lib/server/auth/session";

/**
 * Everything inside a workspace.
 *
 * `requireWorkspace()` here is not the access control — the pages below reach
 * their data through `getDb()`, which calls it again (memoised) and is where the
 * check actually binds. This call is what makes the *layout* fail fast and gives
 * the nav a workspace to render, rather than letting a page paint chrome for a
 * workspace the viewer turns out not to be in.
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  // Read but unused: the slug that matters is the one the proxy put in the
  // header and `requireWorkspace` validated. Awaiting it keeps Next from
  // complaining about an unused dynamic param, and the two cannot disagree —
  // they come from the same path.
  await params;

  const { workspace, role } = await requireWorkspace();

  return (
    <WorkspaceProvider slug={workspace.slug} role={role}>
      <SiteNav />
      {children}
    </WorkspaceProvider>
  );
}
