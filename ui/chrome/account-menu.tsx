"use client";

import { useRouter } from "next/navigation";
import NextLink from "next/link";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import { workspacePath } from "@/lib/workspace-path";
import type { Role } from "@/lib/server/auth/roles";

/**
 * Who you are, which workspace you're in, and the way out.
 *
 * The switcher is a list of plain links rather than a control that sets an
 * "active workspace" somewhere: with the workspace in the URL, switching *is*
 * navigating, and the back button then works by construction. There is no state
 * to keep in sync and nothing to go stale — which was the whole argument for
 * path-scoped routing (docs/multi-user.md).
 *
 * Uses `next/link` directly, not the workspace-aware `<Link>`: these hrefs point
 * at *other* workspaces, so prefixing the current one is exactly wrong.
 */
export function AccountMenu({
  user,
  current,
  role,
  workspaces,
}: {
  user: { name: string; email: string };
  current: { id: string; slug: string; name: string };
  role: Role;
  workspaces: { id: string; slug: string; name: string; role: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const others = workspaces.filter((w) => w.id !== current.id);

  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="relative ml-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1 rounded px-2 py-1 text-sm opacity-70 transition-opacity hover:opacity-100"
      >
        <span className="max-w-[10ch] truncate">{current.name}</span>
        <span aria-hidden className="text-xs">
          ▾
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-60 rounded border border-current/10 bg-background p-1 text-sm shadow-lg"
        >
          <div className="px-2 py-1.5">
            <p className="truncate font-medium">{user.name}</p>
            <p className="truncate text-xs opacity-60">{user.email}</p>
          </div>

          <div className="my-1 border-t border-current/10" />

          <p className="px-2 py-1 text-xs opacity-60">
            {current.name} · {role}
          </p>

          {/* Shown to every role, not just owners: the page is a read for
              members and a control panel for owners, and "who can see my
              money" is a question the least-privileged person most needs to
              be able to answer. */}
          <NextLink
            role="menuitem"
            href={workspacePath(current.slug, "/members")}
            onClick={() => setOpen(false)}
            className="block rounded px-2 py-1 hover:bg-current/5"
          >
            Members
          </NextLink>

          {others.length > 0 ? (
            <>
              <div className="my-1 border-t border-current/10" />
              <p className="px-2 py-1 text-xs opacity-60">Switch workspace</p>
              {others.map((w) => (
                <NextLink
                  key={w.id}
                  role="menuitem"
                  href={workspacePath(w.slug, "/")}
                  onClick={() => setOpen(false)}
                  className="block truncate rounded px-2 py-1 hover:bg-current/5"
                >
                  {w.name}
                </NextLink>
              ))}
            </>
          ) : null}

          <div className="my-1 border-t border-current/10" />

          <NextLink
            role="menuitem"
            href="/enrol-mfa"
            onClick={() => setOpen(false)}
            className="block rounded px-2 py-1 hover:bg-current/5"
          >
            Two-factor
          </NextLink>

          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            className="block w-full rounded px-2 py-1 text-left hover:bg-current/5"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
