"use client";

import { usePathname } from "next/navigation";

import { Link, useWorkspaceSlug } from "@/ui/chrome/workspace-context";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

import { nav, isUnder } from "./nav-data";

export function NavMain() {
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
                  className="data-active:shadow-[inset_2px_0_0_var(--primary)]"
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
