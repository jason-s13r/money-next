import { pageHref, paginate, Pagination, parsePage } from "@/ui/primitives/pagination";
import { StatList } from "@/ui/primitives/stat-list";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { searchTransactions } from "@/lib/server/queries/transactions";
import { parseSort, withSort, type Sort } from "@/lib/transactions/sort";
import { formatMoney } from "@/lib/format";
import { firstParam } from "@/lib/search-params";

// A free-text search over every text field on a transaction (see
// `searchTransactions`). The query lives in the url `?q=` — a search is
// addressable and shareable, and the back button works. The input itself lives
// in the nav bar (see `SearchForm`), which debounces typing into this page.

export const metadata = { title: "Search transactions" };

export default async function SearchPage(props: PageProps<"/w/[workspace]/transactions/search">) {
  const searchParams = await props.searchParams;
  const query = (firstParam(searchParams.q) ?? "").trim();
  const page = parsePage(searchParams.page);
  const sort = parseSort(searchParams.sort);

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <h1 className="sr-only">Search transactions</h1>

      {query ? (
        <Results query={query} page={page} sort={sort} />
      ) : (
        <p className="py-8 text-center text-sm opacity-60">
          Use the search box in the nav bar to search across descriptions,
          merchants, categories, and the particulars, code, reference, and
          counterparty fields.
        </p>
      )}
    </main>
  );
}

async function Results({ query, page, sort }: { query: string; page: number; sort: Sort }) {
  const { items, total, net } = await searchTransactions(query, page, sort);

  // The query rides in the base path; `pageHref` joins `page=` onto it with `&`.
  const basePath = `/transactions/search?q=${encodeURIComponent(query)}`;
  const totalPages = await paginate(total, page, pageHref(withSort(basePath, sort)));

  if (total === 0) {
    return (
      <p className="py-8 text-center text-sm opacity-60">
        No transactions match “{query}”.
      </p>
    );
  }

  return (
    <>
      <StatList
        className="mb-6"
        stats={[
          { label: "Matches", value: total.toLocaleString("en-NZ") },
          { label: "Net", value: formatMoney(net, null) },
        ]}
      />

      <TransactionTable items={items} sort={sort} sortBase={basePath} />
      <Pagination basePath={withSort(basePath, sort)} page={page} totalPages={totalPages} />
    </>
  );
}
