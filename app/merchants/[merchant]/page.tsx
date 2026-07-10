import { notFound, redirect } from "next/navigation";
import { Listing } from "@/app/_components/listing";
import { parsePage } from "@/app/_components/pagination";
import { TransactionTable } from "@/app/_components/transaction-table";
import { TRANSACTIONS_PER_PAGE, getMerchantNames, getMerchantTransactions } from "@/lib/data";
import { formatMoney } from "@/lib/format";
import { fromSlug, slugify } from "@/lib/slug";

// Keyed by merchant *name*, not by Akahu's `merchantId`: one business can arrive
// under two ids ("Kamo Vets" does), and splitting a merchant across two pages by
// an id the reader never sees would be a bug they could not diagnose.

async function resolve(params: Promise<{ merchant: string }>) {
  const { merchant } = await params;
  return fromSlug(await getMerchantNames(), merchant);
}

export async function generateMetadata(props: PageProps<"/merchants/[merchant]">) {
  return { title: (await resolve(props.params)) ?? "Merchant" };
}

export default async function MerchantPage(props: PageProps<"/merchants/[merchant]">) {
  const merchant = await resolve(props.params);
  if (!merchant) notFound();

  const page = parsePage((await props.searchParams).page);
  const { items, total, net } = await getMerchantTransactions(merchant, page);
  const totalPages = Math.ceil(total / TRANSACTIONS_PER_PAGE);

  const basePath = `/merchants/${slugify(merchant)}`;
  if (page > totalPages && totalPages > 0) redirect(`${basePath}?page=${totalPages}`);

  // Refunds are inflows, so a merchant that paid back more than it took nets
  // positive. Say "Net" rather than "Spent", which would be a lie with a sign.
  const spent = -net;

  return (
    <Listing
      back={{ href: "/", label: "Dashboard" }}
      title={merchant}
      stats={[
        { label: spent >= 0 ? "Spent" : "Refunded", value: formatMoney(Math.abs(spent), null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath={basePath}
      page={page}
      totalPages={totalPages}
      empty="No transactions for this merchant."
    >
      {/* Every row names this merchant already. */}
      <TransactionTable items={items} linkMerchant={false} />
    </Listing>
  );
}
