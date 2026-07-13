import Link from "next/link";
import { notFound } from "next/navigation";
import { SearchableSelect, type SelectOption } from "@/app/_components/searchable-select";
import {
  getCategories,
  getMerchants,
  getSimilarTransactions,
  getTransaction,
  getTransferCandidates,
  getTransferGroupLegs,
} from "@/lib/data";
import { formatDateTime, formatMoney } from "@/lib/format";
import { slugify } from "@/lib/slug";
import { setTransactionCategory, setTransactionMerchant } from "./actions";
import { ConflictBanner } from "./conflict-banner";
import { SimilarTransactions } from "./similar-transactions";
import { TransferLink } from "./transfer-link";

export async function generateMetadata(props: PageProps<"/transactions/[transactionId]">) {
  const { transactionId } = await props.params;
  const tx = await getTransaction(transactionId);
  return { title: tx ? (tx.merchantName ?? tx.description) : "Transaction" };
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
  const [categories, merchants, similar, transferLegs, transferCandidates] =
    await Promise.all([
      getCategories(),
      getMerchants(),
      getSimilarTransactions(tx),
      getTransferGroupLegs(tx),
      getTransferCandidates(tx, account.currency),
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
    <main className="mx-auto w-full max-w-3xl p-6">
      <header className="mb-8">
        <p className="text-sm opacity-60">{formatDateTime(tx.date)}</p>
        <h1 className="mt-1 text-2xl font-semibold">
          {tx.merchantName ?? tx.description}
        </h1>
        <p
          className={`mt-2 font-mono text-3xl tabular-nums ${
            tx.amount > 0 ? "text-green-600 dark:text-green-400" : ""
          }`}
        >
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
        <Field label="Bank" value={account.connectionName} />
      </Section>

      <Section title="Enrichment">
        <EditableField
          label="Merchant"
          href={tx.merchantId ? `/merchants/${tx.merchantId}` : null}
          value={tx.merchantName}
        >
          <SearchableSelect
            ariaLabel="Merchant"
            options={merchantOptions}
            value={tx.merchantId}
            valueLabel={tx.merchantName}
            placeholder="Set merchant…"
            clearLabel="No merchant"
            onSelect={setTransactionMerchant.bind(null, tx.id)}
          />
          {merchantConflict ? (
            <ConflictBanner
              conflictId={merchantConflict.id}
              field="merchant"
              userLabel={merchantConflict.userValueLabel}
              akahuLabel={merchantConflict.akahuValueLabel}
            />
          ) : null}
        </EditableField>
        <EditableField
          label="Category"
          href={
            tx.categoryGroup && tx.categoryName
              ? `/categories/${slugify(tx.categoryGroup)}/${slugify(tx.categoryName)}`
              : null
          }
          value={tx.categoryName}
        >
          <SearchableSelect
            ariaLabel="Category"
            options={categoryOptions}
            value={tx.categoryId}
            valueLabel={tx.categoryName}
            placeholder="Set category…"
            clearLabel="Uncategorised"
            onSelect={setTransactionCategory.bind(null, tx.id)}
          />
          {categoryConflict ? (
            <ConflictBanner
              conflictId={categoryConflict.id}
              field="category"
              userLabel={categoryConflict.userValueLabel}
              akahuLabel={categoryConflict.akahuValueLabel}
            />
          ) : null}
        </EditableField>
        <Field
          label="Category group"
          value={tx.categoryGroup}
          href={tx.categoryGroup ? `/categories/${slugify(tx.categoryGroup)}` : null}
        />
      </Section>

      <TransferLink
        sourceId={tx.id}
        sourceAmount={tx.amount}
        sourceCurrency={account.currency}
        legs={transferLegs}
        candidates={transferCandidates}
      />

      <SimilarTransactions
        sourceId={tx.id}
        items={similar}
        category={
          tx.categoryId && tx.categoryName
            ? { id: tx.categoryId, name: tx.categoryName }
            : null
        }
        merchant={
          tx.merchantId && tx.merchantName
            ? { id: tx.merchantId, name: tx.merchantName }
            : null
        }
      />

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 border-b border-current/20 pb-2 text-sm font-medium opacity-60">
        {title}
      </h2>
      <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-6 gap-y-3 text-sm">
        {children}
      </dl>
    </section>
  );
}

/**
 * A labelled row whose value is editable: the control fills the value cell, and
 * when the current value has a list page a small link sits beneath it so the
 * page is still one click away.
 */
function EditableField({
  label,
  value,
  href,
  children,
}: {
  label: string;
  value: string | null;
  href: string | null;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="opacity-60">{label}</dt>
      <dd className="flex flex-col items-start gap-1">
        {children}
        {value && href ? (
          <Link
            href={href}
            className="text-xs text-muted underline underline-offset-2 hover:text-foreground"
          >
            View {value}
          </Link>
        ) : null}
      </dd>
    </>
  );
}

function Field({
  label,
  value,
  mono = false,
  href = null,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  /** Makes the value a link to the list of everything else like it. */
  href?: string | null;
}) {
  const empty = value === null || value === "";

  return (
    <>
      <dt className="opacity-60">{label}</dt>
      <dd className={`break-all ${mono ? "font-mono text-xs" : ""}`}>
        {empty ? (
          <span className="opacity-40">—</span>
        ) : href ? (
          <Link href={href} className="underline underline-offset-2">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
    </>
  );
}
