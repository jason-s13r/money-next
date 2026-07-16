import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { getUncategorisedTransactions } from "@/lib/server/queries/transactions";
import { parseSort, withSort } from "@/lib/transactions/sort";
import { formatMoney } from "@/lib/format";

// A static sibling of `[group]`, which wins the match: "uncategorised" is not one
// of the ten NZFCC groups, and the absence of a category is not a category.

const BASE_PATH = "/categories/uncategorised";

export const metadata = { title: "Uncategorised" };

export default async function UncategorisedPage(props: PageProps<"/categories/uncategorised">) {
  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const sort = parseSort(searchParams.sort);
  const { items, total, net } = await getUncategorisedTransactions(page, sort);
  // The sort rides in the pagination base so paging keeps the chosen order; the
  // table builds its header links off the clean path instead.
  const totalPages = paginate(total, page, pageHref(withSort(BASE_PATH, sort)));

  return (
    <Listing
      title="Uncategorised"
      subtitle=""
      stats={[
        { label: "Net", value: formatMoney(net, null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath={withSort(BASE_PATH, sort)}
      page={page}
      totalPages={totalPages}
      empty="Every transaction is categorised."
    >
      {/* Every row's group and category are, by definition, nothing. */}
      <TransactionTable
        items={items}
        showGroup={false}
        showCategory={false}
        sort={sort}
        sortBase={BASE_PATH}
      />
    </Listing>
  );
}
