import Link from "next/link";
import { Suspense } from "react";
import { SearchForm } from "@/ui/transactions/search-form";

// The global navigation bar shown above every page (rendered once by the root
// layout). A plain server component — links only, no interactivity.

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/breakdown", label: "Breakdown" },
  { href: "/transactions/recent", label: "Transactions" },
  { href: "/accounts", label: "Accounts" },
  { href: "/rules", label: "Rules" },
  { href: "/sync", label: "Sync" },
];

export function SiteNav() {
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
      </nav>
    </header>
  );
}
