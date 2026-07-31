"use client";

import { CircleDollarSignIcon } from "lucide-react";
import { Suspense } from "react";

import type { Role } from "@/lib/server/auth/roles";
import type { BuildInfo } from "@/lib/server/build-info";
import { BuildStamp } from "@/ui/chrome/build-stamp";
import { Link } from "@/ui/chrome/workspace-context";
import { SearchForm } from "@/ui/transactions/search-form";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

import { NavMain } from "./nav-main";
import { NavUser } from "./nav-user";

// The whole left rail: the app wordmark on top, the app's destinations in the
// middle, the signed-in user at the bottom. Replaces the old top nav bar.
//
// A client component (it needs the current path for active state and toggles the
// mobile drawer), fed the identity/workspace data as props by the server layout.
// Destinations use the workspace-aware `<Link>`; the user menu (which now also
// carries workspace switching) uses `next/link` directly, because its hrefs
// point at *other* workspaces (or are already absolute) and prefixing the
// current slug would be wrong.

type Workspace = { id: string; slug: string; name: string };

export function AppSidebar({
  user,
  current,
  role,
  workspaces,
  build,
}: {
  user: { name: string; email: string };
  current: Workspace;
  role: Role;
  workspaces: (Workspace & { role: string })[];
  build: BuildInfo;
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <AppBrand workspace={current.name} />
      </SidebarHeader>
      <SidebarContent>
        {/* Search sits above the destinations. Hidden when the rail collapses to
            icons (a text box can't shrink to a glyph); on mobile it rides at the
            top of the drawer. Suspense because SearchForm reads useSearchParams. */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <Suspense>
            <SearchForm />
          </Suspense>
        </SidebarGroup>
        <NavMain />
      </SidebarContent>
      <SidebarFooter>
        <BuildStamp build={build} />
        <NavUser user={user} current={current} role={role} workspaces={workspaces} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

// The app wordmark, doubling as a link home. `size="lg"` and the square badge
// mirror the sidebar-07 header proportions, so the icon still reads cleanly when
// the rail collapses and the wordmark is hidden. The line beneath names the
// current workspace.
function AppBrand({ workspace }: { workspace: string }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" render={<Link href="/" />}>
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <CircleDollarSignIcon className="size-5" />
          </div>
          <div className="flex flex-col gap-0.5 leading-none">
            <span className="font-medium">Money</span>
            <span className="truncate text-muted">{workspace}</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
