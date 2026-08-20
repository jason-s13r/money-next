"use client";

import NextLink from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  SettingsIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";

import { authClient } from "@/lib/auth-client";
import { workspacePath } from "@/lib/workspace-path";
import type { Role } from "@/lib/server/auth/roles";
import { Link } from "@/ui/chrome/workspace-context";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { ThemeItems } from "./theme-items";

type Workspace = { id: string; slug: string; name: string };

/** Up to two initials for the little square/round badges. */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function NavUser({
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
            <DropdownMenuItem render={<NextLink href="/account" />}>
              <UserRoundIcon />
              Account Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Workspace
              </DropdownMenuLabel>
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
            <DropdownMenuItem render={<Link href="/settings" />}>
              <SettingsIcon />
              Workspace settings
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
