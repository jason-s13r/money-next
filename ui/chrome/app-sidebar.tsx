"use client";

import { usePathname, useRouter } from "next/navigation";
import NextLink from "next/link";
import { useTheme } from "next-themes";
import { Suspense, useSyncExternalStore } from "react";
import {
  LayoutDashboardIcon,
  PieChartIcon,
  WaypointsIcon,
  ArrowRightLeftIcon,
  InboxIcon,
  StoreIcon,
  TagIcon,
  TargetIcon,
  TrendingUpIcon,
  WalletIcon,
  FilterIcon,
  RefreshCwIcon,
  UsersIcon,
  CircleDollarSignIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  UserRoundIcon,
  MonitorIcon,
  SunIcon,
  MoonIcon,
  CheckIcon,
} from "lucide-react";

import { authClient } from "@/lib/auth-client";
import { workspacePath } from "@/lib/workspace-path";
import type { Role } from "@/lib/server/auth/roles";
import type { BuildInfo } from "@/lib/server/build-info";
import { BuildStamp } from "@/ui/chrome/build-stamp";
import { Link, useWorkspaceSlug } from "@/ui/chrome/workspace-context";
import { SearchForm } from "@/ui/transactions/search-form";
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

// The nav is a flat list of labelled sections, always expanded — no collapsing.
// A section with no `label` is an unlabelled cluster of top-level destinations;
// a labelled one heads its items with a muted section label. Every item carries
// an icon so the icon-collapsed rail still reads.
type NavItem = { href: string; label: string; icon: typeof LayoutDashboardIcon };
type NavSection = { label?: string; items: NavItem[] };

const nav: NavSection[] = [
  {
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboardIcon },
      { href: "/accounts", label: "Accounts", icon: WalletIcon },
    ],
  },
  {
    label: "Breakdown",
    items: [
      { href: "/breakdown", label: "Income and spending", icon: PieChartIcon },
      { href: "/breakdown/flow", label: "Money Flow", icon: WaypointsIcon },
      { href: "/budgets", label: "Budgets", icon: TargetIcon },
      { href: "/forecasts", label: "Forecasts", icon: TrendingUpIcon },
    ],
  },
  {
    label: "Transactions",
    items: [
      { href: "/transactions/recent", label: "Recent", icon: ArrowRightLeftIcon },
      { href: "/transactions/uncategorised", label: "Uncategorised", icon: InboxIcon },
      { href: "/merchants", label: "Merchants", icon: StoreIcon },
      { href: "/labels", label: "Labels", icon: TagIcon },
    ],
  },
  {
    label: "Tasks",
    items: [
      { href: "/rules", label: "Rules", icon: FilterIcon },
      { href: "/sync", label: "Sync", icon: RefreshCwIcon },
    ],
  },
];

/** Whether `rel` is `base` itself or a path beneath it. `/` matches only itself. */
function isUnder(rel: string, base: string) {
  return base === "/" ? rel === "/" : rel === base || rel.startsWith(`${base}/`);
}

const themeOptions = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const;

// False during SSR and the first client render, true thereafter — the standard
// mount check, expressed with useSyncExternalStore so there's no setState in an
// effect (which the lint rules, rightly, forbid). Its subscribe never fires; the
// value simply differs between the server and client snapshots.
const noop = () => () => {};
function useMounted() {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/**
 * Light/dark/system switch. next-themes only knows the resolved value after
 * mount (the server can't read the OS), so the tick is withheld until mounted to
 * avoid a hydration mismatch — the items are fully usable before then.
 * `closeOnClick={false}` keeps the menu open so you can see the theme change.
 */
export function ThemeItems() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <>
      {themeOptions.map(({ value, label, icon: Icon }) => (
        <DropdownMenuItem
          key={value}
          closeOnClick={false}
          onClick={() => setTheme(value)}
        >
          <Icon />
          {label}
          {mounted && theme === value ? (
            <CheckIcon className="ml-auto size-4" />
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** Up to two initials for the little square/round badges. */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

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

function NavMain() {
  const pathname = usePathname();
  const slug = useWorkspaceSlug();
  // Selecting a destination should dismiss the mobile drawer; on desktop this is
  // a no-op. Without it the drawer lingers until you tap the backdrop.
  const { setOpenMobile } = useSidebar();

  // App-relative path, so we can compare against the unscoped hrefs above.
  const prefix = `/w/${slug}`;
  const rel = pathname === prefix ? "/" : pathname.slice(prefix.length) || "/";

  // Highlight exactly one destination: the one whose href is the longest prefix
  // of the current path. Avoids "/breakdown" and "/breakdown/flow" both lighting
  // up, or "/rules" and "/rules/runs".
  const hrefs = nav.flatMap((section) => section.items.map((i) => i.href));
  const activeHref = hrefs.reduce<string | null>(
    (best, h) => (isUnder(rel, h) && (!best || h.length > best.length) ? h : best),
    null,
  );

  return (
    <>
      {nav.map((section, index) => (
        <SidebarGroup key={section.label ?? `top-${index}`}>
          {section.label ? <SidebarGroupLabel>{section.label}</SidebarGroupLabel> : null}
          <SidebarMenu>
            {section.items.map((item) => (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  tooltip={item.label}
                  isActive={item.href === activeHref}
                  render={<Link href={item.href} onClick={() => setOpenMobile(false)} />}
                >
                  <item.icon />
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </>
  );
}

function NavUser({
  user,
  current,
  role,
  workspaces,
}: {
  user: { name: string; email: string };
  current: Workspace;
  role: Role;
  workspaces: (Workspace & { role: string })[];
}) {
  const { isMobile } = useSidebar();
  const router = useRouter();
  const others = workspaces.filter((w) => w.id !== current.id);

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
              <span className="truncate text-xs text-muted-foreground">
                {user.email}
              </span>
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
              <p className="truncate text-xs text-muted-foreground">
                {user.email}
              </p>
            </div>
            <DropdownMenuSeparator />
            {/* Top-level, not workspace-scoped: your account belongs to the
                person, so plain next/link. Sits above the workspace section
                because it is about *you*, not whichever workspace you're in. Its
                own area (details, password, sessions, two-factor) has its own
                sidebar once you're there. */}
            <DropdownMenuItem render={<NextLink href="/account" />}>
              <UserRoundIcon />
              Account Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Workspace
              </DropdownMenuLabel>
              {/* Current workspace, with the tick, then any others to switch to.
                  Each targets another slug, so plain next/link — the workspace
                  Link would re-prefix the current one. */}
              <DropdownMenuItem render={<NextLink href={workspacePath(current.slug, "/")} />}>
                <div className="flex size-6 items-center justify-center rounded-md border text-[0.65rem] font-semibold">
                  {initials(current.name)}
                </div>
                <span className="truncate">{current.name}</span>
                <span className="text-xs text-muted-foreground">{role}</span>
                <CheckIcon className="ml-auto size-4" />
              </DropdownMenuItem>
              {others.map((w) => (
                <DropdownMenuItem
                  key={w.id}
                  render={<NextLink href={workspacePath(w.slug, "/")} />}
                >
                  <div className="flex size-6 items-center justify-center rounded-md border text-[0.65rem] font-semibold">
                    {initials(w.name)}
                  </div>
                  <span className="truncate">{w.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/members" />}>
              <UsersIcon />
              Members
            </DropdownMenuItem>
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
