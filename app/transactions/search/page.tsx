import { pageHref, paginate, Pagination, parsePage } from "@/ui/primitives/pagination";
import { StatList } from "@/ui/primitives/stat-list";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { searchTransactions } from "@/lib/server/data";
import { formatMoney } from "@/lib/format";
import { firstParam } from "@/lib/search-params";

// A free-text search over every text field on a transaction (see
// `searchTransactions`). The query lives in the url `?q=` — a search is
// addressable and shareable, and the back button works. The input itself lives
// in the nav bar (see `SearchForm`), which debounces typing into this page.

export const metadata = { title: "Search transactions" };

export default async function SearchPage(props: PageProps<"/transactions/search">) {
  const searchParams = await props.searchParams;
  const query = (firstParam(searchParams.q) ?? "").trim();
  const page = parsePage(searchParams.page);

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Search transactions</h1>
      </header>

      {query ? (
        <Results query={query} page={page} />
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

async function Results({ query, page }: { query: string; page: number }) {
  const { items, total, net } = await searchTransactions(query, page);

  // The query rides in the base path; `pageHref` joins `page=` onto it with `&`.
  const basePath = `/transactions/search?q=${encodeURIComponent(query)}`;
  const totalPages = paginate(total, page, pageHref(basePath));

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

      <TransactionTable items={items} />
      <Pagination basePath={basePath} page={page} totalPages={totalPages} />
    </>
  );
}
