import { AppSidebar } from "@/ui/chrome/app-sidebar";
import { Breadcrumbs } from "@/ui/chrome/breadcrumbs";
import { DataActions } from "./data-actions";
import { WorkspaceProvider } from "@/ui/chrome/workspace-context";
import { requireWorkspace } from "@/lib/server/auth/session";
import { buildInfo } from "@/lib/server/build-info";
import { listWorkspaces } from "@/lib/server/auth/workspaces";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

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

  const [{ user, workspace, role }, workspaces] = await Promise.all([
    requireWorkspace(),
    listWorkspaces(),
  ]);

  return (
    <WorkspaceProvider slug={workspace.slug} role={role}>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar
            user={{ name: user.name, email: user.email }}
            current={workspace}
            role={role}
            workspaces={workspaces}
            build={buildInfo()}
          />
          <SidebarInset>
            {/* Sticky page header: the collapse/drawer toggle and breadcrumbs on
                the left, the global data actions (sync / apply rules) on the
                right. The trigger opens the off-canvas drawer on mobile; search
                lives at the top of the sidebar. */}
            <header className="sticky top-0 z-40 flex items-center gap-2 border-b border-border bg-background/80 px-4 py-2 backdrop-blur">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="h-6 data-[orientation=vertical]:self-center"
              />
              <Breadcrumbs />
              <div className="ml-auto">
                <DataActions />
              </div>
            </header>
            {children}
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </WorkspaceProvider>
  );
}
