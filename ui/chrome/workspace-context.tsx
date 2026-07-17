"use client";

import NextLink from "next/link";
import { createContext, use, type ComponentProps } from "react";

import { workspacePath } from "@/lib/workspace-path";
import type { Role } from "@/lib/server/auth/roles";

/**
 * Which workspace the page being rendered belongs to, and how to link within it.
 *
 * Every URL in the app is now `/w/<slug>/…`. That is what makes a link
 * shareable between members (the same URL means the same data for everyone who
 * can see it), what makes the back button survive a workspace switch, and —
 * quietly — what makes any future cache key workspace-specific for free, since
 * the path *is* the key. See docs/multi-user.md.
 *
 * The cost of that is a prefix on every href, and this is the one idiom that
 * pays it. `<Link href="/rules">` becomes exactly the same line, importing
 * `Link` from here instead of from `next/link`, and the slug comes from context
 * rather than from a prop threaded through every component.
 *
 * Deliberately *not* a `wsPath(session, …)` helper as the plan sketched: that
 * needs the slug in hand at every call site, which means either a prop drilled
 * through the whole tree or an argument each caller can forget. A forgotten
 * prefix here is not a bug you'd see — the link works, it just silently leaves
 * the workspace.
 */

type WorkspaceContextValue = { slug: string; role: Role };

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  slug,
  role,
  children,
}: {
  slug: string;
  role: Role;
  children: React.ReactNode;
}) {
  return <WorkspaceContext value={{ slug, role }}>{children}</WorkspaceContext>;
}

function useWorkspace() {
  const value = use(WorkspaceContext);
  if (!value) {
    throw new Error(
      "No workspace in context. This component renders inside app/w/[workspace]/ " +
        "only — a page outside it has no workspace to link within.",
    );
  }
  return value;
}

/** The current workspace's slug. Throws outside `/w/[workspace]/`, by design. */
export function useWorkspaceSlug() {
  return useWorkspace().slug;
}

/** The current user's role in this workspace. */
export function useRole() {
  return useWorkspace().role;
}

/**
 * May this user change things here?
 *
 * **Not a control.** Every mutating action re-asks the real question on the
 * server (`requireRole`), and it has to, because a server action is a public POST
 * endpoint that does not care what the UI rendered (T9). This is only for
 * deciding whether to *offer* something.
 *
 * It exists because "the button is refused" and "the button isn't there" are
 * different products. The first viewer this app ever had — phase 4's whole point
 * — found the app rendering every edit control to them and throwing a 500 on
 * click: the gate held, and the UI had been lying about what they could do since
 * the moment roles were built, because until sharing shipped there was nobody who
 * wasn't an owner to notice.
 *
 * Deliberately coarse. `viewer` is the read-only role and the only one this
 * question has ever needed to separate; when `editor` and `owner` diverge in the
 * UI, ask the specific question there rather than growing a second vocabulary
 * beside `lib/server/auth/roles.ts`, which is where the hierarchy is written down.
 */
export function useCanEdit() {
  return useRole() !== "viewer";
}

export { workspacePath };

/**
 * `next/link`, with the current workspace prefixed onto app-relative hrefs.
 *
 * An href that is already absolute (`http…`) or already workspace-scoped
 * (`/w/…`) is passed through untouched, so the workspace switcher and any
 * outbound link still work.
 */
export function Link({ href, ...props }: ComponentProps<typeof NextLink>) {
  const slug = useWorkspaceSlug();

  const scoped =
    typeof href === "string" && href.startsWith("/") && !href.startsWith("/w/")
      ? workspacePath(slug, href)
      : href;

  return <NextLink href={scoped} {...props} />;
}
