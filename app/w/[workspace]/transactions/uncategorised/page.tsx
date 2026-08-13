import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { getUncategorisedTransactions } from "@/lib/server/queries/transactions";
import { parseSort, withSort } from "@/lib/transactions/sort";
import { formatMoney } from "@/lib/format";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

// A transactions listing, sibling of `recent`: the transactions with no category
// yet. The absence of a category is not a category, so this lives under
// transactions rather than under a category group.

const BASE_PATH = "/transactions/uncategorised";

export const metadata = { title: "Uncategorised" };

export default async function UncategorisedPage(props: PageProps<"/w/[workspace]/transactions/uncategorised">) {
  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const sort = parseSort(searchParams.sort);
  const { items, total, net } = await getUncategorisedTransactions(page, sort);
  // The sort rides in the pagination base so paging keeps the chosen order; the
  // table builds its header links off the clean path instead.
  const totalPages = await paginate(total, page, pageHref(withSort(BASE_PATH, sort)));

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
      <TransactionTable items={items} sort={sort} sortBase={BASE_PATH} />
    </Listing>
  );
}
