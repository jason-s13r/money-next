import { notFound } from "next/navigation";
import { Listing } from "@/ui/transactions/listing";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { getMerchant } from "@/lib/server/queries/lookups";
import { getMerchantTransactions } from "@/lib/server/queries/transactions";
import { parseSort, withSort } from "@/lib/transactions/sort";
import { formatMoney } from "@/lib/format";

// Keyed by Akahu's `merchantId`, so the url is stable and unambiguous. One
// business can arrive under two ids ("Kamo Vets" has two); this page is exactly
// the id the reader clicked, which is what every merchant link now carries.

export async function generateMetadata(props: PageProps<"/w/[workspace]/merchants/[merchantId]">) {
  const { merchantId } = await props.params;
  const merchant = await getMerchant(merchantId);
  return { title: merchant?.name ?? "Merchant" };
}

export default async function MerchantPage(props: PageProps<"/w/[workspace]/merchants/[merchantId]">) {
  const { merchantId } = await props.params;
  const merchant = await getMerchant(merchantId);
  if (!merchant) notFound();

  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const sort = parseSort(searchParams.sort);
  const { items, total, net } = await getMerchantTransactions(merchantId, page, sort);

  const basePath = `/merchants/${merchantId}`;
  const totalPages = await paginate(total, page, pageHref(withSort(basePath, sort)));

  // Refunds are inflows, so a merchant that paid back more than it took nets
  // positive. Say "Net" rather than "Spent", which would be a lie with a sign.
  const spent = -net;

  return (
    <Listing
      title={
        <span className="flex items-center gap-3">
          {merchant.logo ? (
            <img
              src={merchant.logo}
              alt=""
              className="h-8 w-8 rounded object-contain"
            />
          ) : null}
          {merchant.name}
        </span>
      }
      stats={[
        { label: spent >= 0 ? "Spent" : "Refunded", value: formatMoney(Math.abs(spent), null) },
        { label: "Transactions", value: total.toLocaleString("en-NZ") },
      ]}
      basePath={withSort(basePath, sort)}
      page={page}
      totalPages={totalPages}
      empty="No transactions for this merchant."
    >
      {/* Every row names this merchant already. */}
      <TransactionTable items={items} linkMerchant={false} sort={sort} sortBase={basePath} />
    </Listing>
  );
}
