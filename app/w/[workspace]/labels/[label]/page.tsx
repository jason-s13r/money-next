import { notFound } from "next/navigation";
import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { getLabelNames, getLabelTransactions } from "@/lib/server/queries/transactions";
import { parseSort, withSort } from "@/lib/transactions/sort";
import { formatMoney } from "@/lib/format";
import { fromSlug, slugify } from "@/lib/slug";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

// Every transaction carrying a user label (see `Label`). Keyed by the tag's name
// slug and resolved back against the labels actually on record, so an unknown or
// ambiguous slug 404s rather than listing nothing — the same round-trip the
// type/category pages use (see lib/slug.ts `fromSlug`).

async function resolve(params: Promise<{ label: string }>) {
  const { label } = await params;
  return fromSlug(await getLabelNames(), label);
}

export async function generateMetadata(props: PageProps<"/w/[workspace]/labels/[label]">) {
  return { title: (await resolve(props.params)) ?? "Label" };
}

export default async function LabelPage(props: PageProps<"/w/[workspace]/labels/[label]">) {
  const name = await resolve(props.params);
  if (!name) notFound();

  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const sort = parseSort(searchParams.sort);
  const { items, total, net } = await getLabelTransactions(name, page, sort);

  const basePath = `/labels/${slugify(name)}`;
  const totalPages = await paginate(total, page, pageHref(withSort(basePath, sort)));

  return (
    <Listing
      title={name}
      subtitle="Label"
      // A tag spans both directions (an inflow and an outflow can share it), so the
      // total is a signed net rather than a one-way "spent".
      stats={[
        { label: "Net", value: formatMoney(net, null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath={withSort(basePath, sort)}
      page={page}
      totalPages={totalPages}
      empty="No transactions carry this label."
    >
      <TransactionTable items={items} sort={sort} sortBase={basePath} />
    </Listing>
  );
}
