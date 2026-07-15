import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { PendingTable } from "@/ui/transactions/pending-table";
import { getPendingTransactions } from "@/lib/server/queries/pending";
import { getRecentTransactions } from "@/lib/server/queries/transactions";
import { formatMoney } from "@/lib/format";

// The unfiltered listing: every transaction across every account, newest first,
// of every type (transfers included). The nav's Transactions link lands here.

export const metadata = { title: "Recent transactions" };

export default async function RecentPage(props: PageProps<"/transactions/recent">) {
  const page = parsePage((await props.searchParams).page);
  const { items, total, net } = await getRecentTransactions(page);
  // Pending holds sit atop the first page only, so they aren't repeated on every
  // paginated page of the settled ledger below.
  const pending = page === 1 ? await getPendingTransactions() : [];

  const basePath = "/transactions/recent";
  const totalPages = paginate(total, page, pageHref(basePath));

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
      basePath={basePath}
      page={page}
      totalPages={totalPages}
      empty="No transactions yet."
    >
      {pending.length > 0 ? <PendingTable items={pending} /> : null}
      <TransactionTable items={items} />
    </Listing>
  );
}
