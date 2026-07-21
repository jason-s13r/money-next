"use client";

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

import { Link, useWorkspaceSlug } from "@/ui/chrome/workspace-context";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

// The page title, shown in the header where sidebar-07 puts its breadcrumb. The
// title itself is whatever each page already declares through Next `metadata`
// (every page sets one), so this reads `document.title` rather than making each
// page hand its title up a second time. Dynamic pages (an account, a merchant)
// therefore get their real name here for free.
//
// A parent crumb is derived from the path for the deeper routes, so a detail
// page reads "Accounts / ANZ Cheque" and links back to the section.

// The site title template is "%s · Money" (app/layout.tsx); strip that tail back
// to the page's own title.
const SUFFIX = " · Money";
function pageTitleFromDocument(docTitle: string) {
  const t = docTitle.endsWith(SUFFIX) ? docTitle.slice(0, -SUFFIX.length) : docTitle;
  return t === "Money" ? "" : t;
}

// SSR-stable titles for the static routes, so their crumb is correct in the
// server HTML (no first-paint flash and no hydration mismatch, since these equal
// what `document.title` resolves to on the client). Dynamic routes are absent
// here and fill in from `document.title` once mounted.
const staticTitles: Record<string, string> = {
  "/": "Dashboard",
  "/breakdown": "Income and spending",
  "/breakdown/flow": "Money Flow",
  "/transactions/recent": "Recent transactions",
  "/transactions/search": "Search transactions",
  "/accounts": "Accounts",
  "/rules": "Rules",
  "/rules/runs": "Rules log",
  "/sync": "Sync history",
  "/members": "Members",
  "/transactions/uncategorised": "Uncategorised",
};

// First path segment → the section crumb shown before a detail page's own title.
// `href` present means the section has a landing page to link back to.
const sections: Record<string, { label: string; href?: string }> = {
  breakdown: { label: "Breakdown", href: "/breakdown" },
  transactions: { label: "Transactions", href: "/transactions/recent" },
  accounts: { label: "Accounts", href: "/accounts" },
  rules: { label: "Rules", href: "/rules" },
  categories: { label: "Categories" },
  merchants: { label: "Merchants" },
  card: { label: "Cards" },
  sync: { label: "Sync", href: "/sync" },
  members: { label: "Members", href: "/members" },
};

function subscribe(onChange: () => void) {
  if (typeof document === "undefined") return () => {};
  // The <title> node's text changes (and the node itself can be replaced) as
  // navigation resolves new metadata; watching the head subtree catches both.
  const observer = new MutationObserver(onChange);
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return () => observer.disconnect();
}

function useDocumentTitle() {
  return useSyncExternalStore(
    subscribe,
    () => document.title,
    () => null,
  );
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const slug = useWorkspaceSlug();
  const docTitle = useDocumentTitle();

  const prefix = `/w/${slug}`;
  const rel = pathname === prefix ? "/" : pathname.slice(prefix.length) || "/";
  const segments = rel.split("/").filter(Boolean);

  // Prefer the live document title; fall back to the static map during SSR / the
  // first paint so static pages render their crumb server-side.
  const title = (docTitle ? pageTitleFromDocument(docTitle) : "") || staticTitles[rel] || "";

  // Show the section crumb for detail pages (a level below the section), and also
  // for a section landing whose own title differs from the section name — so
  // "/breakdown" reads "Breakdown / Income and spending" — but not when the two
  // would merely repeat (e.g. "/accounts" stays just "Accounts").
  const sectionDef = segments.length > 0 ? sections[segments[0]] : undefined;
  const section =
    sectionDef && (segments.length > 1 || sectionDef.label !== title) ? sectionDef : undefined;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {section ? (
          <>
            <BreadcrumbItem>
              {section.href && section.href !== rel ? (
                <BreadcrumbLink render={<Link href={section.href} />}>
                  {section.label}
                </BreadcrumbLink>
              ) : (
                <span>{section.label}</span>
              )}
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </>
        ) : null}
        <BreadcrumbItem>
          <BreadcrumbPage>{title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
