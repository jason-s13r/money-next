import { redirect } from "next/navigation";
import { Listing } from "@/app/_components/listing";
import { parsePage } from "@/app/_components/pagination";
import { TransactionTable } from "@/app/_components/transaction-table";
import { TRANSACTIONS_PER_PAGE, getUncategorisedTransactions } from "@/lib/data";
import { formatMoney } from "@/lib/format";

// A static sibling of `[group]`, which wins the match: "uncategorised" is not one
// of the ten NZFCC groups, and the absence of a category is not a category.

export const metadata = { title: "Uncategorised" };

export default async function UncategorisedPage(props: PageProps<"/categories/uncategorised">) {
  const page = parsePage((await props.searchParams).page);
  const { items, total, net } = await getUncategorisedTransactions(page);
  const totalPages = Math.ceil(total / TRANSACTIONS_PER_PAGE);

  if (page > totalPages && totalPages > 0) redirect(`/categories/uncategorised?page=${totalPages}`);

  return (
    <Listing
      back={{ href: "/", label: "Dashboard" }}
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
      {/* Every row's category is, by definition, nothing. */}
      <TransactionTable items={items} showCategory={false} />
    </Listing>
  );
}
