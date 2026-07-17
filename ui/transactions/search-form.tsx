"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { useWorkspaceSlug } from "@/ui/chrome/workspace-context";
import { workspacePath } from "@/lib/workspace-path";

// The transaction search box that lives in the nav bar. Typing debounces into a
// client-side navigation to /transactions/search, so results stream in as you
// type while the query stays addressable in the url (the back button works, and
// a search is shareable). Without JavaScript the surrounding <form> still submits
// a plain GET, so search degrades gracefully.

const SEARCH_PATH = "/transactions/search";
const DEBOUNCE_MS = 250;

export function SearchForm() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // This one builds its urls rather than rendering a <Link>, so it prefixes the
  // workspace itself. The no-JS <form action> below needs a real path too.
  const searchPath = workspacePath(useWorkspaceSlug(), SEARCH_PATH);

  const urlQuery = searchParams.get("q") ?? "";
  const [value, setValue] = useState(urlQuery);

  // Reflect the url back into the input when the query changes elsewhere —
  // back/forward navigation, following a link, or clearing the search. Adjusting
  // during render rather than in an effect: React re-runs this component before
  // committing, so the input never paints the stale value.
  const [lastUrlQuery, setLastUrlQuery] = useState(urlQuery);
  if (urlQuery !== lastUrlQuery) {
    setLastUrlQuery(urlQuery);
    setValue(urlQuery);
  }

  const navigate = (next: string) => {
    const q = next.trim();
    const href = q ? `${searchPath}?q=${encodeURIComponent(q)}` : searchPath;
    startTransition(() => {
      // Replace once we're on the search page so every keystroke doesn't pile a
      // new entry onto the history stack; push the first time to transition onto
      // the page (and keep the origin page in history).
      if (pathname === searchPath) router.replace(href);
      else router.push(href);
    });
  };

  // Debounce keystrokes into a navigation. Skip when the typed value already
  // matches the url so syncing from the url (above) can't trigger a re-navigate.
  useEffect(() => {
    if (value.trim() === urlQuery.trim()) return;
    const id = setTimeout(() => navigate(value), DEBOUNCE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <form
      action={searchPath}
      role="search"
      className="flex"
      onSubmit={(event) => {
        // Enter navigates immediately rather than waiting on the debounce.
        event.preventDefault();
        navigate(value);
      }}
    >
      <input
        type="search"
        name="q"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search transactions…"
        aria-label="Search transactions"
        className={`w-full rounded-lg border border-current/20 bg-transparent px-3 py-2 text-sm outline-none transition-opacity focus:border-current/50 ${
          isPending ? "opacity-60" : ""
        }`}
      />
    </form>
  );
}
