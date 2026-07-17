import { notFound } from "next/navigation";
import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { getTransactionTypes, getTypeTransactions } from "@/lib/server/queries/transactions";
import { formatMoney } from "@/lib/format";
import { fromSlug, slugify } from "@/lib/slug";

// Keyed by Akahu's transaction `type` (DEBIT, CREDIT, TRANSFER, EFTPOS, FEE, …).
// The slug is resolved back against the types actually on record, so an unknown
// one 404s rather than listing nothing — and a type that carries a space, like
// "STANDING ORDER", round-trips through its slug without a second source of truth.

async function resolve(params: Promise<{ type: string }>) {
  const { type } = await params;
  return fromSlug(await getTransactionTypes(), type);
}

export async function generateMetadata(props: PageProps<"/w/[workspace]/transactions/type/[type]">) {
  return { title: (await resolve(props.params)) ?? "Type" };
}

export default async function TypePage(props: PageProps<"/w/[workspace]/transactions/type/[type]">) {
  const type = await resolve(props.params);
  if (!type) notFound();

  const page = parsePage((await props.searchParams).page);
  const { items, total, net } = await getTypeTransactions(type, page);

  const basePath = `/transactions/type/${slugify(type)}`;
  const totalPages = await paginate(total, page, pageHref(basePath));

  return (
    <Listing
      title={type}
      subtitle="Transaction type"
      // A type spans both directions (a TRANSFER, a reversed FEE), so its total is
      // a signed net rather than a one-way "spent".
      stats={[
        { label: "Net", value: formatMoney(net, null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath={basePath}
      page={page}
      totalPages={totalPages}
      empty="No transactions of this type."
    >
      {/* The Type column would read the same on every row. */}
      <TransactionTable items={items} showType={false} />
    </Listing>
  );
}
