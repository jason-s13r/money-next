import { notFound } from "next/navigation";
import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { getCardSuffixes, getCardTransactions } from "@/lib/server/queries/transactions";
import { parseSort, withSort } from "@/lib/transactions/sort";
import { formatMoney } from "@/lib/format";

/** Matched exactly, not slugged: a suffix is already url-safe digits. */
async function resolve(params: Promise<{ suffix: string }>) {
  const { suffix } = await params;
  const known = await getCardSuffixes();
  return known.includes(suffix) ? suffix : null;
}

const label = (suffix: string) => `Card ···· ${suffix}`;

export async function generateMetadata(props: PageProps<"/w/[workspace]/card/[suffix]">) {
  const suffix = await resolve(props.params);
  return { title: suffix ? label(suffix) : "Card" };
}

export default async function CardPage(props: PageProps<"/w/[workspace]/card/[suffix]">) {
  const suffix = await resolve(props.params);
  if (!suffix) notFound();

  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const sort = parseSort(searchParams.sort);
  const { items, total, net } = await getCardTransactions(suffix, page, sort);

  const basePath = `/card/${suffix}`;
  const totalPages = await paginate(total, page, pageHref(withSort(basePath, sort)));

  const spent = -net;

  return (
    <Listing
      title={label(suffix)}
      // The same suffix can appear on more than one account, so the Account
      // column is doing real work here rather than repeating the heading.
      subtitle="Transactions the bank attributed to this card."
      stats={[
        { label: spent >= 0 ? "Spent" : "Received", value: formatMoney(Math.abs(spent), null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath={withSort(basePath, sort)}
      page={page}
      totalPages={totalPages}
      empty="No transactions on this card."
    >
      <TransactionTable items={items} sort={sort} sortBase={basePath} />
    </Listing>
  );
}
