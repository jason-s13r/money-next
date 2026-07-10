import Link from "next/link";

/** `?page=` is user input: anything that isn't a positive integer means page 1. */
export function parsePage(raw: string | string[] | undefined): number {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(value) || value < 1) return 1;
  return value;
}

/**
 * Newest-first pages, so "next" is *older*. Labelling the links by direction in
 * time rather than by page number keeps the reader oriented in a list where the
 * top is today.
 *
 * Page 1 carries no `?page=`, so a category's canonical url stays clean.
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
  const linkClass = "underline underline-offset-2";
  const disabledClass = "opacity-30";
  const href = (n: number) => (n === 1 ? basePath : `${basePath}?page=${n}`);

  return (
    <nav className="mt-6 flex items-center justify-between text-sm">
      {page > 1 ? (
        <Link href={href(page - 1)} className={linkClass}>
          ← Newer
        </Link>
      ) : (
        <span className={disabledClass}>← Newer</span>
      )}

      <span className="opacity-60">
        Page {page} of {totalPages}
      </span>

      {page < totalPages ? (
        <Link href={href(page + 1)} className={linkClass}>
          Older →
        </Link>
      ) : (
        <span className={disabledClass}>Older →</span>
      )}
    </nav>
  );
}
