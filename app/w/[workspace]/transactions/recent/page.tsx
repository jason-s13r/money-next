import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { PendingTable } from "@/ui/transactions/pending-table";
import { getPendingTransactions } from "@/lib/server/queries/pending";
import { getRecentTransactions } from "@/lib/server/queries/transactions";
import { parseSort, withSort } from "@/lib/transactions/sort";
import { formatMoney } from "@/lib/format";

// The unfiltered listing: every transaction across every account, newest first,
// of every type (transfers included). The nav's Transactions link lands here.

export const metadata = { title: "Recent transactions" };

export default async function RecentPage(props: PageProps<"/w/[workspace]/transactions/recent">) {
  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const sort = parseSort(searchParams.sort);
  const { items, total, net } = await getRecentTransactions(page, sort);
  // Pending holds sit atop the first page only, so they aren't repeated on every
  // paginated page of the settled ledger below.
  const pending = page === 1 ? await getPendingTransactions() : [];

  const basePath = "/transactions/recent";
  const totalPages = await paginate(total, page, pageHref(withSort(basePath, sort)));

  return (
    <Listing
      title="Recent transactions"
      subtitle=""
      // Spans both directions across every type, so the total is a signed net
      // rather than a one-way "spent".
      stats={[
        { label: "Net", value: formatMoney(net, null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath={withSort(basePath, sort)}
      page={page}
      totalPages={totalPages}
      empty="No transactions yet."
    >
      {pending.length > 0 ? <PendingTable items={pending} /> : null}
      <TransactionTable items={items} sort={sort} sortBase={basePath} />
    </Listing>
  );
}
