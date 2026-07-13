import Link from "next/link";
import { redirect } from "next/navigation";
import { parsePage } from "@/app/_components/pagination";
import { TransactionTable } from "@/app/_components/transaction-table";
import { TRANSACTIONS_PER_PAGE, searchTransactions } from "@/lib/data";
import { formatMoney } from "@/lib/format";

// A free-text search over every text field on a transaction (see
// `searchTransactions`). Rendered from a plain GET form so the query lives in the
// url — a search is addressable and shareable, and the back button works — with
// no client-side JavaScript.

export const metadata = { title: "Search transactions" };

function firstParam(raw: string | string[] | undefined): string {
  return (Array.isArray(raw) ? raw[0] : raw) ?? "";
}

export default async function SearchPage(props: PageProps<"/transactions/search">) {
  const searchParams = await props.searchParams;
  const query = firstParam(searchParams.q).trim();
  const page = parsePage(searchParams.page);

  const linkClass = "underline underline-offset-2";
  const disabledClass = "opacity-30";

  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Search transactions</h1>

        {/* GET, so submitting reloads the page with `?q=`. The page input is
            absent, so every new search lands on page 1. */}
        <form action="/transactions/search" className="mt-4 flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={query}
            autoFocus
            placeholder="Description, merchant, reference, particulars…"
            aria-label="Search transactions"
            className="w-full rounded-lg border border-current/20 bg-transparent px-3 py-2 text-sm outline-none focus:border-current/50"
          />
          <button
            type="submit"
            className="rounded-lg border border-current/20 px-4 py-2 text-sm font-medium hover:border-current/50"
          >
            Search
          </button>
        </form>
      </header>

      {query ? (
        <Results query={query} page={page} linkClass={linkClass} disabledClass={disabledClass} />
      ) : (
        <p className="py-8 text-center text-sm opacity-60">
          Search across descriptions, merchants, categories, and the
          particulars, code, reference, and counterparty fields.
        </p>
      )}
    </main>
  );
}

async function Results({
  query,
  page,
  linkClass,
  disabledClass,
}: {
  query: string;
  page: number;
  linkClass: string;
  disabledClass: string;
}) {
  const { items, total, net } = await searchTransactions(query, page);
  const totalPages = Math.ceil(total / TRANSACTIONS_PER_PAGE);

  // `?page=` past the end (a stale link, or fewer results than before) snaps to
  // the last real page rather than showing an empty table.
  const href = (n: number) =>
    n === 1
      ? `/transactions/search?q=${encodeURIComponent(query)}`
      : `/transactions/search?q=${encodeURIComponent(query)}&page=${n}`;
  if (page > totalPages && totalPages > 0) redirect(href(totalPages));

  if (total === 0) {
    return (
      <p className="py-8 text-center text-sm opacity-60">
        No transactions match “{query}”.
      </p>
    );
  }

  return (
    <>
      <dl className="mb-6 flex flex-wrap gap-x-10 gap-y-3 text-sm">
        <div>
          <dt className="opacity-60">Matches</dt>
          <dd className="font-mono tabular-nums">{total.toLocaleString("en-NZ")}</dd>
        </div>
        <div>
          <dt className="opacity-60">Net</dt>
          <dd className="font-mono tabular-nums">{formatMoney(net, null)}</dd>
        </div>
      </dl>

      <TransactionTable items={items} />

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
    </>
  );
}
