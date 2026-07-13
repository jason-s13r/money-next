import { notFound, redirect } from "next/navigation";
import { Listing } from "@/app/_components/listing";
import { parsePage } from "@/app/_components/pagination";
import { TransactionTable } from "@/app/_components/transaction-table";
import { TRANSACTIONS_PER_PAGE, getCardSuffixes, getCardTransactions } from "@/lib/data";
import { formatMoney } from "@/lib/format";

/** Matched exactly, not slugged: a suffix is already url-safe digits. */
async function resolve(params: Promise<{ suffix: string }>) {
  const { suffix } = await params;
  const known = await getCardSuffixes();
  return known.includes(suffix) ? suffix : null;
}

const label = (suffix: string) => `Card ···· ${suffix}`;

export async function generateMetadata(props: PageProps<"/card/[suffix]">) {
  const suffix = await resolve(props.params);
  return { title: suffix ? label(suffix) : "Card" };
}

export default async function CardPage(props: PageProps<"/card/[suffix]">) {
  const suffix = await resolve(props.params);
  if (!suffix) notFound();

  const page = parsePage((await props.searchParams).page);
  const { items, total, net } = await getCardTransactions(suffix, page);
  const totalPages = Math.ceil(total / TRANSACTIONS_PER_PAGE);

  const basePath = `/card/${suffix}`;
  if (page > totalPages && totalPages > 0) redirect(`${basePath}?page=${totalPages}`);

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
      basePath={basePath}
      page={page}
      totalPages={totalPages}
      empty="No transactions on this card."
    >
      {/* Every row is this card already. */}
      <TransactionTable items={items} showCard={false} />
    </Listing>
  );
}
