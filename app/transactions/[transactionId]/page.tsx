import Link from "next/link";
import { notFound } from "next/navigation";
import { getTransaction } from "@/lib/data";
import { formatDateTime, formatMoney } from "@/lib/format";
import { slugify } from "@/lib/slug";

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

  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <nav className="mb-4 text-sm">
        <Link
          href={`/accounts/${account.id}`}
          className="underline underline-offset-2 opacity-60"
        >
          ← {account.name}
        </Link>
      </nav>

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
        <Field label="Type" value={tx.type} />
        <Field
          label="Balance after"
          value={tx.balance === null ? null : formatMoney(tx.balance, account.currency)}
        />
        <Field label="Account" value={account.name} />
        <Field label="Bank" value={account.connectionName} />
      </Section>

      <Section title="Enrichment">
        <Field
          label="Merchant"
          value={tx.merchantName}
          href={tx.merchantName ? `/merchants/${slugify(tx.merchantName)}` : null}
        />
        <Field
          label="Category"
          value={tx.categoryName}
          href={
            tx.categoryGroup && tx.categoryName
              ? `/categories/${slugify(tx.categoryGroup)}/${slugify(tx.categoryName)}`
              : null
          }
        />
        <Field
          label="Category group"
          value={tx.categoryGroup}
          href={tx.categoryGroup ? `/categories/${slugify(tx.categoryGroup)}` : null}
        />
      </Section>

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
