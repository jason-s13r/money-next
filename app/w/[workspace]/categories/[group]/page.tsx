import { notFound } from "next/navigation";
import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { isEssential, isIncomeGroup, groupFromSlug } from "@/lib/categories";
import { getGroupTransactions } from "@/lib/server/queries/transactions";
import { parseSort, withSort } from "@/lib/transactions/sort";
import { formatMoney } from "@/lib/format";
import { slugify } from "@/lib/slug";

export async function generateMetadata(props: PageProps<"/w/[workspace]/categories/[group]">) {
  const group = groupFromSlug((await props.params).group);
  return { title: group ?? "Category" };
}

export default async function GroupPage(props: PageProps<"/w/[workspace]/categories/[group]">) {
  // The ten NZFCC spending groups are a closed set, so an unknown slug is a 404
  // rather than an empty list — there is no group here that merely has no rows.
  const group = groupFromSlug((await props.params).group);
  if (!group) notFound();

  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const sort = parseSort(searchParams.sort);
  const { items, total, net } = await getGroupTransactions(group, page, sort);

  const basePath = `/categories/${slugify(group)}`;
  const totalPages = await paginate(total, page, pageHref(withSort(basePath, sort)));

  return (
    <Listing
      title={group}
      subtitle={isIncomeGroup(group) ? "Money in" : `${isEssential(group) ? "Essential" : "Discretionary"} spending`}
      stats={[
        isIncomeGroup(group) || net > 0
          ? { label: "Earnt", value: formatMoney(net, null) }
          : { label: "Spent", value: formatMoney(-net, null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath={withSort(basePath, sort)}
      page={page}
      totalPages={totalPages}
      empty={isIncomeGroup(group) ? "No income in this period." : "No spending in this category group."}
    >
      {/* Every row is in this group already. */}
      <TransactionTable items={items} showGroup={false} sort={sort} sortBase={basePath} />
    </Listing>
  );
}
