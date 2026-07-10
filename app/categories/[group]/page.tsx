import { notFound, redirect } from "next/navigation";
import { Listing } from "@/app/_components/listing";
import { parsePage } from "@/app/_components/pagination";
import { TransactionTable } from "@/app/_components/transaction-table";
import { isEssential, groupFromSlug } from "@/lib/categories";
import { TRANSACTIONS_PER_PAGE, getGroupTransactions } from "@/lib/data";
import { formatMoney } from "@/lib/format";
import { slugify } from "@/lib/slug";

export async function generateMetadata(props: PageProps<"/categories/[group]">) {
  const group = groupFromSlug((await props.params).group);
  return { title: group ?? "Category" };
}

export default async function GroupPage(props: PageProps<"/categories/[group]">) {
  // The ten NZFCC spending groups are a closed set, so an unknown slug is a 404
  // rather than an empty list — there is no group here that merely has no rows.
  const group = groupFromSlug((await props.params).group);
  if (!group) notFound();

  const page = parsePage((await props.searchParams).page);
  const { items, total, net } = await getGroupTransactions(group, page);
  const totalPages = Math.ceil(total / TRANSACTIONS_PER_PAGE);

  // A `?page=` past the end would render an empty table under a "Page 9 of 3".
  if (page > totalPages && totalPages > 0) {
    redirect(`/categories/${slugify(group)}?page=${totalPages}`);
  }

  return (
    <Listing
      back={{ href: "/", label: "Dashboard" }}
      title={group}
      subtitle={`${isEssential(group) ? "Essential" : "Discretionary"} spending`}
      stats={[
        { label: "Spent", value: formatMoney(-net, null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath={`/categories/${slugify(group)}`}
      page={page}
      totalPages={totalPages}
      empty="No spending in this category group."
    >
      <TransactionTable items={items} />
    </Listing>
  );
}
