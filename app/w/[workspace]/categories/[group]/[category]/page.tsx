import { notFound } from "next/navigation";
import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { groupFromSlug, isIncomeGroup } from "@/lib/categories";
import { getCategoryNames, getCategoryTransactions } from "@/lib/server/queries/transactions";
import { parseSort, withSort } from "@/lib/transactions/sort";
import { formatMoney } from "@/lib/format";
import { fromSlug, slugify } from "@/lib/slug";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

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

export async function generateMetadata(props: PageProps<"/w/[workspace]/categories/[group]/[category]">) {
  const found = await resolve(props.params);
  return { title: found?.category ?? "Category" };
}

export default async function CategoryPage(props: PageProps<"/w/[workspace]/categories/[group]/[category]">) {
  const found = await resolve(props.params);
  if (!found) notFound();
  const { group, category } = found;

  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const sort = parseSort(searchParams.sort);
  const { items, total, net } = await getCategoryTransactions(group, category, page, sort);

  const basePath = `/categories/${slugify(group)}/${slugify(category)}`;
  const totalPages = await paginate(total, page, pageHref(withSort(basePath, sort)));

  return (
    <Listing
      title={category}
      subtitle={group}
      stats={[
        isIncomeGroup(group) || net > 0
          ? { label: "Earnt", value: formatMoney(net, null) }
          : { label: "Spent", value: formatMoney(-net, null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath={withSort(basePath, sort)}
      page={page}
      totalPages={totalPages}
      empty={isIncomeGroup(group) ? "No income in this category." : "No spending in this category."}
    >
      {/* Every row shares this group, so the category cell drops its group subtitle. */}
      <TransactionTable items={items} showGroup={false} sort={sort} sortBase={basePath} />
    </Listing>
  );
}
