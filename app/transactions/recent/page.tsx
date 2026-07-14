import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { getRecentTransactions } from "@/lib/server/data";
import { formatMoney } from "@/lib/format";

// The unfiltered listing: every transaction across every account, newest first,
// of every type (transfers included). The nav's Transactions link lands here.

export const metadata = { title: "Recent transactions" };

export default async function RecentPage(props: PageProps<"/transactions/recent">) {
  const page = parsePage((await props.searchParams).page);
  const { items, total, net } = await getRecentTransactions(page);

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
      <TransactionTable items={items} />
    </Listing>
  );
}
