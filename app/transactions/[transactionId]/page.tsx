import { notFound } from "next/navigation";
import { SearchableSelect, type SelectOption } from "@/ui/primitives/searchable-select";
import { positiveAmountClass } from "@/lib/ui/amount";
import { getCategories, getMerchants, getTransaction, getRulesForTransaction } from "@/lib/server/queries/lookups";
import { getTransactionHistory } from "@/lib/server/queries/history";
import {
  getSimilarTransactions,
  getTransferCandidates,
  getTransferGroupLegs,
} from "@/lib/server/matching/matching";
import { formatDateTime, formatMoney } from "@/lib/format";
import { slugify } from "@/lib/slug";
import { setTransactionCategory } from "./actions/category";
import {
  createMerchantAndSetForTransaction,
  setTransactionMerchant,
} from "./actions/merchant";
import { ConflictBanner } from "@/ui/transactions/detail/conflict-banner";
import { TransactionHistory } from "@/ui/transactions/detail/history";
import { SimilarTransactions } from "@/ui/transactions/detail/similar-transactions";
import { LearnRule } from "@/ui/transactions/detail/learn-rule";
import { MatchingRules } from "@/ui/transactions/detail/matching-rules";
import { TransferLink } from "@/ui/transactions/detail/transfer-link";
import { EditableField, Field, Section } from "@/ui/transactions/detail/transaction-fields";

export async function generateMetadata(props: PageProps<"/transactions/[transactionId]">) {
  const { transactionId } = await props.params;
  const tx = await getTransaction(transactionId);
  return { title: tx ? (tx.merchant?.name ?? tx.description) : "Transaction" };
}

// Transaction ids are globally unique, so this route sits at the top level
// rather than nested under its account. A future all-accounts transaction list
// can link straight here.
export default async function TransactionPage(
  props: PageProps<"/transactions/[transactionId]">,
) {
  const { transactionId } = await props.params;

  const tx = await getTransaction(transactionId);
  if (!tx) notFound();

  const { account } = tx;

  // Options for the enrichment pickers. Loaded here so the page stays one server
  // round-trip; both are small enough to hand to the client whole (see
  // SearchableSelect). The bound actions carry this transaction's id.
  const [categories, merchants, similar, transferLegs, transferCandidates, rulesForTx, history] =
    await Promise.all([
      getCategories(),
      getMerchants(),
      getSimilarTransactions(tx),
      getTransferGroupLegs(tx),
      getTransferCandidates(tx, account.currency),
      getRulesForTransaction({ type: tx.type, description: tx.description }),
      getTransactionHistory(transactionId),
    ]);

  const categoryOptions: SelectOption[] = categories.map((c) => ({
    value: c.id,
    label: c.name,
    hint: c.groupName ?? undefined,
  }));
  const merchantOptions: SelectOption[] = merchants.map((m) => ({
    value: m.id,
    label: m.name,
  }));

  const categoryConflict = tx.conflicts.find((c) => c.field === "category");
  const merchantConflict = tx.conflicts.find((c) => c.field === "merchant");

  return (
    <main className="mx-auto w-full max-w-3xl p-2">
      <header className="mb-8">
        <p className="text-sm opacity-60">{formatDateTime(tx.date)}</p>
        <h1 className="mt-1 text-2xl font-semibold">
          {tx.merchant?.name ?? tx.description}
        </h1>
        <p className={`mt-2 font-mono text-3xl tabular-nums ${positiveAmountClass(tx.amount)}`}>
          {formatMoney(tx.amount, account.currency)}
        </p>
      </header>

      <Section title="Transaction">
        <Field label="Description" value={tx.description} />
        <Field
          label="Type"
          value={tx.type}
          href={tx.type ? `/transactions/type/${slugify(tx.type)}` : null}
        />
        <Field
          label="Balance after"
          value={tx.balance === null ? null : formatMoney(tx.balance, account.currency)}
        />
        <Field label="Account" value={account.name} href={`/accounts/${account.id}`} />
        <Field
          label="Bank"
          value={
            account.connection?.logo ? (
              <span className="flex items-center gap-2">
                <img src={account.connection.logo} alt="" className="h-5 w-5 rounded object-contain" />
                {account.connection.name}
              </span>
            ) : (
              account.connection?.name ?? account.connectionId
            )
          }
        />
      </Section>

      <Section title="Enrichment">
        <EditableField
          label="Merchant"
          href={tx.merchantId ? `/merchants/${tx.merchantId}` : null}
          value={tx.merchant?.name ?? null}
        >
          <SearchableSelect
            ariaLabel="Merchant"
            options={merchantOptions}
            value={tx.merchantId}
            valueLabel={tx.merchant?.name ?? null}
            placeholder="Set merchant…"
            clearLabel="No merchant"
            onSelect={setTransactionMerchant.bind(null, tx.id)}
            onCreate={createMerchantAndSetForTransaction.bind(null, tx.id)}
            createLabel="Create merchant “%s”"
          />
          {merchantConflict ? (
            <ConflictBanner
              conflictId={merchantConflict.id}
              field="merchant"
              heldSource={merchantConflict.heldSource}
              userLabel={merchantConflict.userValueLabel}
              akahuLabel={merchantConflict.akahuValueLabel}
            />
          ) : null}
        </EditableField>
        <EditableField
          label="Category"
          href={
            tx.categoryGroup && tx.category?.name
              ? `/categories/${slugify(tx.categoryGroup.name)}/${slugify(tx.category.name)}`
              : null
          }
          value={tx.category?.name ?? null}
        >
          <SearchableSelect
            ariaLabel="Category"
            options={categoryOptions}
            value={tx.categoryId}
            valueLabel={tx.category?.name ?? null}
            placeholder="Set category…"
            clearLabel="Uncategorised"
            onSelect={setTransactionCategory.bind(null, tx.id)}
          />
          {categoryConflict ? (
            <ConflictBanner
              conflictId={categoryConflict.id}
              field="category"
              heldSource={categoryConflict.heldSource}
              userLabel={categoryConflict.userValueLabel}
              akahuLabel={categoryConflict.akahuValueLabel}
            />
          ) : null}
        </EditableField>
        <Field
          label="Category group"
          value={tx.categoryGroup?.name ?? null}
          href={tx.categoryGroup ? `/categories/${slugify(tx.categoryGroup.name)}` : null}
        />
      </Section>

      <TransferLink
        sourceId={tx.id}
        sourceAmount={tx.amount}
        sourceCurrency={account.currency}
        legs={transferLegs}
        candidates={transferCandidates}
      />

      {/* Directly under the three fields it explains — merchant, category and
          transfer — since it is the answer to the question those fields raise:
          why does it say that, and who decided? */}
      <TransactionHistory entries={history} />

      <SimilarTransactions
        sourceId={tx.id}
        items={similar}
        category={
          tx.categoryId && tx.category?.name
            ? { id: tx.categoryId, name: tx.category.name }
            : null
        }
        merchant={
          tx.merchantId && tx.merchant?.name
            ? { id: tx.merchantId, name: tx.merchant.name }
            : null
        }
      />

      <MatchingRules
        matching={rulesForTx.matching}
        transferMatches={rulesForTx.transferMatches}
      >
        <LearnRule
          transactionId={tx.id}
          hasCategory={tx.categoryId != null}
          hasMerchant={tx.merchantId != null}
        />
      </MatchingRules>

      <Section title="Bank metadata">
        <Field label="Particulars" value={tx.particulars} />
        <Field label="Code" value={tx.code} />
        <Field label="Reference" value={tx.reference} />
        <Field label="Other account" value={tx.otherAccount} mono />
        <Field
          label="Card suffix"
          value={tx.cardSuffix}
          mono
          href={tx.cardSuffix ? `/card/${tx.cardSuffix}` : null}
        />
      </Section>

      <Section title="Record">
        <Field label="Transaction id" value={tx.id} mono />
        <Field label="Account id" value={tx.accountId} mono />
        <Field label="Connection id" value={tx.connectionId} mono />
        <Field label="Hash" value={tx.hash} mono />
        <Field label="Created (Akahu)" value={formatDateTime(tx.createdAt)} />
        <Field label="Updated (Akahu)" value={formatDateTime(tx.updatedAt)} />
        <Field label="Synced locally" value={formatDateTime(tx.syncedAt)} />
      </Section>
    </main>
  );
}
