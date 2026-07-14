import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { getUncategorisedTransactions } from "@/lib/server/data";
import { formatMoney } from "@/lib/format";

// A static sibling of `[group]`, which wins the match: "uncategorised" is not one
// of the ten NZFCC groups, and the absence of a category is not a category.

export const metadata = { title: "Uncategorised" };

export default async function UncategorisedPage(props: PageProps<"/categories/uncategorised">) {
  const page = parsePage((await props.searchParams).page);
  const { items, total, net } = await getUncategorisedTransactions(page);
  const totalPages = paginate(total, page, pageHref("/categories/uncategorised"));

  return (
    <Listing
      title="Uncategorised"
      subtitle="Transactions with no specific category, in either direction. Counted in the totals, but not yet assigned one."
      stats={[
        { label: "Net", value: formatMoney(net, null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath="/categories/uncategorised"
      page={page}
      totalPages={totalPages}
      empty="Every transaction is categorised."
    >
      {/* Every row's group and category are, by definition, nothing. */}
      <TransactionTable items={items} showGroup={false} showCategory={false} />
    </Listing>
  );
}
