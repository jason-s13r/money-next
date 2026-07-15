import { firstParam } from "@/lib/search-params";

/**
 * Column sorting for a transaction listing, carried in the url as `?sort=field-dir`
 * (e.g. `amount-desc`) so a sorted view is addressable and the back button works.
 *
 * Only the uncategorised page wires this today — its review queue is worked
 * largest-first — but the field set covers every column the shared table shows, so
 * turning it on for another listing is a matter of passing the props.
 */
export const SORT_FIELDS = [
  "date",
  "description",
  "account",
  "category",
  "card",
  "type",
  "amount",
  "balance",
] as const;

export type SortField = (typeof SORT_FIELDS)[number];
export type SortDir = "asc" | "desc";
export type Sort = { field: SortField; dir: SortDir };

// The direction a column sorts to on its first click: money and dates read
// most-interesting-first (largest, newest), text reads A→Z. Amount is ordered by
// magnitude on the uncategorised page (see `getUncategorisedTransactions`), so
// "desc" there genuinely means the biggest transactions first.
const DEFAULT_DIR: Record<SortField, SortDir> = {
  date: "desc",
  amount: "desc",
  balance: "desc",
  description: "asc",
  account: "asc",
  category: "asc",
  card: "asc",
  type: "asc",
};

/** The order a listing falls back to with no `?sort=`: newest first. */
export const DEFAULT_SORT: Sort = { field: "date", dir: "desc" };

const isSortField = (v: string): v is SortField => (SORT_FIELDS as readonly string[]).includes(v);

/** `?sort=` is user input: anything unrecognised means the default order. */
export function parseSort(raw: string | string[] | undefined): Sort {
  const value = firstParam(raw);
  if (!value) return DEFAULT_SORT;
  const [field, dir] = value.split("-");
  if (!field || !isSortField(field)) return DEFAULT_SORT;
  return { field, dir: dir === "asc" ? "asc" : "desc" };
}

/**
 * The `sort` param value for a sort, or `null` when it is the default order — so a
 * listing's canonical url stays clean rather than carrying `?sort=date-desc`.
 */
export function serializeSort(sort: Sort): string | null {
  if (sort.field === DEFAULT_SORT.field && sort.dir === DEFAULT_SORT.dir) return null;
  return `${sort.field}-${sort.dir}`;
}

/** Adds `?sort=` (or `&sort=`) to a base path, dropping it for the default order. */
export function withSort(base: string, sort: Sort): string {
  const value = serializeSort(sort);
  if (value === null) return base;
  return `${base}${base.includes("?") ? "&" : "?"}sort=${value}`;
}

/**
 * The href a column header links to: clicking the active column flips its
 * direction, clicking another starts it at its natural direction. `?page=` is
 * intentionally not carried, so a re-sort returns to the first page — where the
 * new ordering begins.
 */
export function sortHref(base: string, field: SortField, current: Sort): string {
  const dir: SortDir =
    current.field === field ? (current.dir === "asc" ? "desc" : "asc") : DEFAULT_DIR[field];
  return withSort(base, { field, dir });
}
