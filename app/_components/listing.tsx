import Link from "next/link";
import { Pagination } from "./pagination";

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
  title: string;
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

  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm opacity-60">{subtitle}</p> : null}

        <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-3 text-sm">
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt className="opacity-60">{stat.label}</dt>
              <dd className="font-mono tabular-nums">{stat.value}</dd>
            </div>
          ))}
        </dl>
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
