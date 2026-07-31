"use client";

import NextLink from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CircleDollarSignIcon,
  LayoutDashboardIcon,
  UserRoundIcon,
  KeyRoundIcon,
  MonitorSmartphoneIcon,
  ShieldCheckIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
} from "lucide-react";

import { authClient } from "@/lib/auth-client";
import type { BuildInfo } from "@/lib/server/build-info";
import { BuildStamp } from "@/ui/chrome/build-stamp";
import { initials } from "@/ui/chrome/nav-user";
import { ThemeItems } from "@/ui/chrome/theme-items";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

// The account area's own left rail — a *user-scoped* sidebar, deliberately not
// the workspace one (ui/chrome/app-sidebar).
//
// /account lives above `/w/[workspace]/` on purpose: your name, password and
// sessions belong to you, not to a workspace, and a user with no workspace at
// all must still reach them (app/account/page). That is exactly why the app
// sidebar can't be reused here — its nav, breadcrumbs and data actions all need
// a workspace slug from context, which this route has none of. So this rail
// carries only what makes sense without one: the branding, the account-area
// destinations, and — the thing the page was missing — a way back to `/`, which
// signposts into the user's dashboard.
//
// Every href is an absolute top-level path, so there is no workspace `Link`
// prefixing and no `WorkspaceProvider`; plain `next/link` throughout.

type NavItem = { href: string; label: string; icon: typeof LayoutDashboardIcon };

// "Return to the app" sits on its own above the account destinations — it is the
// way out of settings, not another settings page. `/` is a signpost that redirects
// into the workspace you were last in (app/page reads the cookie proxy.ts sets),
// which is what makes this a way *back* rather than a way somewhere else.
const backToApp: NavItem = { href: "/", label: "Dashboard", icon: LayoutDashboardIcon };

const accountNav: NavItem[] = [
  { href: "/account", label: "Details", icon: UserRoundIcon },
  { href: "/account/password", label: "Password", icon: KeyRoundIcon },
  { href: "/account/sessions", label: "Sessions", icon: MonitorSmartphoneIcon },
  { href: "/enrol-mfa", label: "Two-factor", icon: ShieldCheckIcon },
];

export function AccountSidebar({
  user,
  build,
}: {
  user: { name: string; email: string };
  build: BuildInfo;
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <AppBrand />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <NavLink item={backToApp} />
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Account</SidebarGroupLabel>
          <SidebarMenu>
            {accountNav.map((item) => (
              <NavLink key={item.href} item={item} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <BuildStamp build={build} />
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

// The wordmark, doubling as a link home. Mirrors the app sidebar's header so the
// two rails read as the same product; the subtitle says which area you're in
// rather than naming a workspace, since there isn't one here.
function AppBrand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" render={<NextLink href="/" />}>
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <CircleDollarSignIcon className="size-5" />
          </div>
          <div className="flex flex-col gap-0.5 leading-none">
            <span className="font-medium">Money</span>
            <span className="truncate text-muted">Account</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function NavLink({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  // Exact match: these are leaf routes, and `/` must not light up on `/account`.
  const isActive = pathname === item.href;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={item.label}
        isActive={isActive}
        render={<NextLink href={item.href} onClick={() => setOpenMobile(false)} />}
      >
        <item.icon />
        <span>{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// The signed-in user, with theme and sign-out. A trimmed version of the app
// sidebar's NavUser: no workspace switcher, because this rail has no workspace
// in hand — switching stays in the app sidebar, where a slug is available.
function NavUser({ user }: { user: { name: string; email: string } }) {
  const { isMobile } = useSidebar();
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
              />
            }
          >
            <div className="flex aspect-square size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold">
              {initials(user.name)}
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
            <ChevronsUpDownIcon className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-60"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <div className="px-1.5 py-1">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Theme
              </DropdownMenuLabel>
              <ThemeItems />
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
