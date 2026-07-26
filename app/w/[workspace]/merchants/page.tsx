import { getMerchantsWithCounts } from "@/lib/server/queries/lookups";
import { StatList } from "@/ui/primitives/stat-list";
import { MerchantsList } from "@/ui/merchants/merchants-list";

// The index of merchants this workspace actually uses — every merchant that tags
// at least one of its transactions, each a link to that merchant's own listing.
// Merchants aren't created here directly; a private one is minted by typing a new
// name into the merchant picker on a transaction, so those are flagged "Yours".

export const metadata = { title: "Merchants" };

export default async function MerchantsPage() {
  const merchants = await getMerchantsWithCounts();
  const tagged = merchants.reduce((sum, m) => sum + m.count, 0);
  const yours = merchants.filter((m) => m.userCreated).length;

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <h1 className="sr-only">Merchants</h1>

      <StatList
        className="mt-4 mb-4"
        stats={[
          { label: "Merchants", value: merchants.length.toLocaleString("en-NZ") },
          { label: "Custom", value: yours.toLocaleString("en-NZ") },
          { label: "Transactions", value: tagged.toLocaleString("en-NZ") },
        ]}
      />

      {merchants.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">
          No merchants yet. Set a merchant on a transaction — on its page or inline
          in any listing — to see it here.
        </p>
      ) : (
        <MerchantsList merchants={merchants} />
      )}
    </main>
  );
}
