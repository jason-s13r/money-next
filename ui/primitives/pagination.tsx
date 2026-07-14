import { redirect } from "next/navigation";
import { TRANSACTIONS_PER_PAGE } from "@/lib/server/data";
import { firstParam } from "@/lib/search-params";
import { NavPair } from "./nav-pair";

/** `?page=` is user input: anything that isn't a positive integer means page 1. */
export function parsePage(raw: string | string[] | undefined): number {
  const value = Number(firstParam(raw));
  if (!Number.isInteger(value) || value < 1) return 1;
  return value;
}

/**
 * The page-count every listing derives from a total, and the past-the-end guard
 * they all share: a `?page=` beyond the last real page (a stale link, or fewer
 * rows than before) would otherwise render an empty table under a "Page 9 of 3"
 * footer, so it redirects to the last page instead. `pageHref` builds the target
 * url for a page number, keeping any other query params (a search's `?q=`) intact.
 *
 * Returns the total page count for the caller to hand to {@link Pagination}. Note
 * `redirect` throws, so control never returns from it.
 */
export function paginate(
  total: number,
  page: number,
  pageHref: (page: number) => string,
  perPage = TRANSACTIONS_PER_PAGE,
): number {
  const totalPages = Math.ceil(total / perPage);
  if (page > totalPages && totalPages > 0) redirect(pageHref(totalPages));
  return totalPages;
}

/**
 * The `?page=` url for a page number under `basePath`. Page 1 carries no `?page=`,
 * so a listing's canonical url stays clean; a `basePath` that already holds a query
 * (search's `?q=`) gets `page=` joined with `&` rather than a second `?`. Shared by
 * the pager and the past-the-end redirect (see {@link paginate}) so both agree.
 */
export const pageHref = (basePath: string) => (n: number) =>
  n === 1 ? basePath : `${basePath}${basePath.includes("?") ? "&" : "?"}page=${n}`;

/**
 * Newest-first pages, so "next" is *older*. Labelling the links by direction in
 * time rather than by page number keeps the reader oriented in a list where the
 * top is today.
 */
export function Pagination({
  basePath,
  page,
  totalPages,
}: {
  basePath: string;
  page: number;
  totalPages: number;
}) {
  const href = pageHref(basePath);
  return (
    <NavPair
      className="mt-6"
      left={{ href: page > 1 ? href(page - 1) : null, label: "← Newer" }}
      right={{ href: page < totalPages ? href(page + 1) : null, label: "Older →" }}
      center={
        <span className="opacity-60">
          Page {page} of {totalPages}
        </span>
      }
    />
  );
}
