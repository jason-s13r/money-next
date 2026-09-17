import Image from "next/image";
import { notFound } from "next/navigation";
import { pageHref, paginate, Pagination, parsePage } from "@/ui/primitives/pagination";
import { StatList } from "@/ui/primitives/stat-list";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { PendingTable } from "@/ui/transactions/pending-table";
import { AccountHeading } from "@/ui/accounts/account-name";
import { Link } from "@/ui/chrome/workspace-context";
import { requireWorkspace } from "@/lib/server/auth/session";
import { getAccount } from "@/lib/server/queries/accounts";
import { getAccountPendingTransactions } from "@/lib/server/queries/pending";
import { getAccountTransactions } from "@/lib/server/queries/transactions";
import { parseSort, withSort } from "@/lib/transactions/sort";
import { accountLabel } from "@/lib/account-name";
import { formatMoney } from "@/lib/format";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export async function generateMetadata(props: PageProps<"/w/[workspace]/accounts/[accountId]">) {
  const { accountId } = await props.params;
  const account = await getAccount(accountId);
  return { title: account ? accountLabel(account) : "Account" };
}

export default async function AccountPage(props: PageProps<"/w/[workspace]/accounts/[accountId]">) {
  const { accountId } = await props.params;
  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const sort = parseSort(searchParams.sort);

  const account = await getAccount(accountId);
  if (!account) notFound();

  const superseded = account.supersededBy;

  // Renaming an account is `account.update`, which a viewer does not hold. The
  // button is hidden for them; the action checks for itself (T9).
  const { role } = await requireWorkspace();
  const canEdit = role !== "viewer";

  const { items, total } = await getAccountTransactions(accountId, page, sort);
  // Pending holds sit atop the first page only, so they aren't repeated on every
  // paginated page of this account's settled ledger below.
  const pending = page === 1 ? await getAccountPendingTransactions(accountId) : [];
  const basePath = `/accounts/${accountId}`;
  const totalPages = await paginate(total, page, pageHref(withSort(basePath, sort)));

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <header className="mb-6">
        <AccountHeading
          accountId={account.id}
          name={account.name}
          displayName={account.displayName}
          canEdit={canEdit}
          logo={
            account.connection?.logo ? (
              <Image
                src={account.connection.logo}
                alt=""
                width={32}
                height={32}
                loading="lazy"
                decoding="async"
                className="h-8 w-8 rounded object-contain"
              />
            ) : null
          }
          meta={
            <>
              {account.connection?.name ?? account.connectionId} · {account.type}
              {account.formattedAccount ? ` · ${account.formattedAccount}` : ""}
            </>
          }
        />

        <StatList
          className="mt-4"
          stats={[
            {
              label: superseded ? "Balance at merge" : "Balance",
              value: formatMoney(account.balanceCurrent, account.currency),
            },
            {
              label: superseded ? "Available at merge" : "Available",
              value: formatMoney(account.balanceAvailable, account.currency),
            },
            ...(account.balanceLimit !== null
              ? [{ label: "Limit", value: formatMoney(account.balanceLimit, account.currency) }]
              : []),
            { label: "Transactions", value: total.toLocaleString("en-NZ") },
            ...(pending.length > 0
              ? [{ label: "Pending", value: pending.length.toLocaleString("en-NZ") }]
              : []),
          ]}
        />
      </header>

      {/* A tombstone that still has a ledger needs saying so above it, not in an
          empty state it will never reach: these rows are the part of the history
          the migration never re-issued, and without a word here the page looks
          like a live account that has quietly stopped updating. */}
      {superseded && total > 0 ? (
        <p className="mb-4 rounded border border-current/15 px-3 py-2 text-sm opacity-60">
          {account.connection?.name ?? "This bank"} replaced this account when it moved to open
          banking, and its newer transactions now live on{" "}
          <Link href={`/accounts/${superseded.id}`} className="underline underline-offset-2">
            {accountLabel(superseded)}
          </Link>
          . What is left here was never re-issued under the new account, so it stays — and it is
          still counted in search, spending and budgets.
        </p>
      ) : null}

      {/* Every row is this account, so the Account column is dropped. */}
      {pending.length > 0 ? <PendingTable items={pending} showAccount={false} /> : null}

      {total === 0 ? (
        pending.length === 0 ? (
          superseded ? (
            // "No transactions" is true and useless here: it reads as data loss
            // when what happened is that the history was moved somewhere better.
            // Say where, and link to it.
            <div className="py-8 text-center text-sm">
              <p className="opacity-60">
                {account.connection?.name ?? "This bank"} replaced this account when it moved to
                open banking. Every transaction it had was re-issued under{" "}
                <Link href={`/accounts/${superseded.id}`} className="underline underline-offset-2">
                  {accountLabel(superseded)}
                </Link>
                , which now holds the full history.
              </p>
              <p className="mt-2 opacity-40">
                Kept so the old id cannot come back, and so the balances above still
                explain what this account was worth when it was merged.
              </p>
            </div>
          ) : (
            <p className="py-8 text-center text-sm opacity-60">
              No transactions for this account.
            </p>
          )
        ) : null
      ) : (
        <>
          {/* A single account's ledger shows its running Balance under each
              amount — meaningless once rows from different accounts interleave. */}
          <TransactionTable items={items} showBalance sort={sort} sortBase={basePath} />
          <Pagination basePath={withSort(basePath, sort)} page={page} totalPages={totalPages} />
        </>
      )}
    </main>
  );
}
