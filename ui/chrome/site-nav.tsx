import { Link } from "@/ui/chrome/workspace-context";
import { Suspense } from "react";
import { SearchForm } from "@/ui/transactions/search-form";
import { listWorkspaces } from "@/lib/server/auth/workspaces";
import { requireWorkspace } from "@/lib/server/auth/session";
import { AccountMenu } from "./account-menu";

// The navigation bar shown above every page inside a workspace (rendered by
// app/w/[workspace]/layout.tsx — it used to live in the root layout, and moved
// when the workspace moved into the URL: every link here is workspace-relative,
// and /login has no workspace to link within).
//
// Still a server component. `<Link>` is the workspace-aware one, so these hrefs
// stay written the way they always were.

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/breakdown", label: "Breakdown" },
  { href: "/breakdown/flow", label: "Flow" },
  { href: "/transactions/recent", label: "Transactions" },
  { href: "/accounts", label: "Accounts" },
  { href: "/rules", label: "Rules" },
  { href: "/sync", label: "Sync" },
];

export async function SiteNav() {
  const [{ user, workspace, role }, workspaces] = await Promise.all([
    requireWorkspace(),
    listWorkspaces(),
  ]);

  return (
    <header className="sticky top-0 z-50 border-b border-current/10 bg-background/80 backdrop-blur">
      <nav
        className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-2 text-sm"
        aria-label="Global"
      >
        <Link href="/" className="font-semibold">
          Money
        </Link>
        <ul className="flex items-center gap-4">
          {navItems.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="opacity-60 transition-opacity hover:opacity-100"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="ml-auto hidden min-w-0 max-w-xs sm:block">
          <Suspense>
            <SearchForm />
          </Suspense>
        </div>
        <AccountMenu
          user={{ name: user.name, email: user.email }}
          current={workspace}
          role={role}
          workspaces={workspaces}
        />
      </nav>
    </header>
  );
}
