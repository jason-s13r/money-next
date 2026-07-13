import { notFound, redirect } from "next/navigation";
import { Listing } from "@/app/_components/listing";
import { parsePage } from "@/app/_components/pagination";
import { TransactionTable } from "@/app/_components/transaction-table";
import { groupFromSlug, isIncomeGroup } from "@/lib/categories";
import { TRANSACTIONS_PER_PAGE, getCategoryNames, getCategoryTransactions } from "@/lib/data";
import { formatMoney } from "@/lib/format";
import { fromSlug, slugify } from "@/lib/slug";

/**
 * A subcategory is only meaningful inside its group, so it is resolved against
 * the names that group actually holds. A category with no rows has no page:
 * there are 208 NZFCC categories and this dashboard has seen 77 of them.
 */
async function resolve(params: Promise<{ group: string; category: string }>) {
  const { group: groupSlug, category: categorySlug } = await params;
  const group = groupFromSlug(groupSlug);
  if (!group) return null;

  const category = fromSlug(await getCategoryNames(group), categorySlug);
  return category ? { group, category } : null;
}

export async function generateMetadata(props: PageProps<"/categories/[group]/[category]">) {
  const found = await resolve(props.params);
  return { title: found?.category ?? "Category" };
}

export default async function CategoryPage(props: PageProps<"/categories/[group]/[category]">) {
  const found = await resolve(props.params);
  if (!found) notFound();
  const { group, category } = found;

  const page = parsePage((await props.searchParams).page);
  const { items, total, net } = await getCategoryTransactions(group, category, page);
  const totalPages = Math.ceil(total / TRANSACTIONS_PER_PAGE);

  const basePath = `/categories/${slugify(group)}/${slugify(category)}`;
  if (page > totalPages && totalPages > 0) redirect(`${basePath}?page=${totalPages}`);

  return (
    <Listing
      back={{ href: `/categories/${slugify(group)}`, label: group }}
      title={category}
      subtitle={group}
      stats={[
        isIncomeGroup(group) || net > 0
          ? { label: "Earnt", value: formatMoney(net, null) }
          : { label: "Spent", value: formatMoney(-net, null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath={basePath}
      page={page}
      totalPages={totalPages}
      empty={isIncomeGroup(group) ? "No income in this category." : "No spending in this category."}
    >
      {/* The Category column would read the same on every row. */}
      <TransactionTable items={items} showCategory={false} />
    </Listing>
  );
}
