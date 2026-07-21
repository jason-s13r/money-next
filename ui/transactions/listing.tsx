import { Pagination } from "@/ui/primitives/pagination";
import { StatList } from "@/ui/primitives/stat-list";

/**
 * The frame shared by every transaction listing: where you came from, what this
 * bucket is, what it totals, and how to page through it.
 *
 * The stats describe the *whole* bucket, not the page on screen — a reader who
 * clicked a $9,253 row is here to see that number, and would not trust a page
 * that quietly reported the sum of the fifty rows it happened to show.
 */
export function Listing({
  title,
  subtitle,
  stats,
  basePath,
  page,
  totalPages,
  empty,
  children,
}: {
  title: React.ReactNode;
  subtitle?: string;
  stats: { label: string; value: string }[];
  basePath: string;
  page: number;
  totalPages: number;
  /** Shown instead of the table and pager when the bucket holds nothing. */
  empty: string;
  children: React.ReactNode;
}) {
  const isEmpty = totalPages === 0;

  // The title now shows in the header breadcrumb (ui/chrome/breadcrumbs.tsx). It
  // stays here as an sr-only heading so the page keeps one h1 for assistive tech,
  // while the visible frame carries only the subtitle context and bucket stats.
  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <header className="mb-6">
        <h1 className="sr-only">{title}</h1>
        {subtitle ? <p className="text-sm opacity-60">{subtitle}</p> : null}

        <StatList stats={stats} className="mt-4" />
      </header>

      {isEmpty ? (
        <p className="py-8 text-center text-sm opacity-60">{empty}</p>
      ) : (
        <>
          {children}
          <Pagination basePath={basePath} page={page} totalPages={totalPages} />
        </>
      )}
    </main>
  );
}
