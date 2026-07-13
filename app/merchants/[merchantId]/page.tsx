import { notFound, redirect } from "next/navigation";
import { Listing } from "@/app/_components/listing";
import { parsePage } from "@/app/_components/pagination";
import { TransactionTable } from "@/app/_components/transaction-table";
import { TRANSACTIONS_PER_PAGE, getMerchant, getMerchantTransactions } from "@/lib/data";
import { formatMoney } from "@/lib/format";

// Keyed by Akahu's `merchantId`, so the url is stable and unambiguous. One
// business can arrive under two ids ("Kamo Vets" has two); this page is exactly
// the id the reader clicked, which is what every merchant link now carries.

export async function generateMetadata(props: PageProps<"/merchants/[merchantId]">) {
  const { merchantId } = await props.params;
  const merchant = await getMerchant(merchantId);
  return { title: merchant?.name ?? "Merchant" };
}

export default async function MerchantPage(props: PageProps<"/merchants/[merchantId]">) {
  const { merchantId } = await props.params;
  const merchant = await getMerchant(merchantId);
  if (!merchant) notFound();

  const page = parsePage((await props.searchParams).page);
  const { items, total, net } = await getMerchantTransactions(merchantId, page);
  const totalPages = Math.ceil(total / TRANSACTIONS_PER_PAGE);

  const basePath = `/merchants/${merchantId}`;
  if (page > totalPages && totalPages > 0) redirect(`${basePath}?page=${totalPages}`);

  // Refunds are inflows, so a merchant that paid back more than it took nets
  // positive. Say "Net" rather than "Spent", which would be a lie with a sign.
  const spent = -net;

  return (
    <Listing
      title={merchant.name}
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
