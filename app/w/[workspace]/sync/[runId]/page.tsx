import { notFound } from "next/navigation";
import { getSyncRun } from "@/lib/server/queries/runs";
import { getSyncRunTransactions } from "@/lib/server/queries/transactions";
import { formatDateTime, formatMoney } from "@/lib/format";
import { parseSort, withSort } from "@/lib/transactions/sort";
import { Listing } from "@/ui/transactions/listing";
import { TransactionTable } from "@/ui/transactions/transaction-table";
import { AutoRefresh } from "@/ui/primitives/auto-refresh";
import { pageHref, paginate, parsePage } from "@/ui/primitives/pagination";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

// What one sync run brought in. `/sync` is the list; this is a run's own arrivals,
// which is what `Transaction.syncRunId` records — the tag that used to stand in for
// it (`ingested-<date>`) grouped a whole UTC day.

export const metadata = { title: "Sync run" };

export default async function SyncRunPage(props: PageProps<"/w/[workspace]/sync/[runId]">) {
  const { runId } = await props.params;

  // No parse: run ids are opaque, and the scoped client makes an id belonging to
  // another workspace exactly as unknown as a made-up one.
  const run = await getSyncRun(runId);
  if (!run) notFound();

  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const sort = parseSort(searchParams.sort);
  const { items, total, net } = await getSyncRunTransactions(runId, page, sort);

  const basePath = `/sync/${runId}`;
  const totalPages = await paginate(total, page, pageHref(withSort(basePath, sort)));

  const window = run.days ? `${run.days} days` : run.full ? "full history" : "incremental";
  const pending = run.status === "queued" || run.status === "running";

  return (
    <>
      <AutoRefresh active={pending} />
      <Listing
        title="Sync run"
        subtitle={`${run.bankLink?.name ?? "Disconnected bank"} · ${window} · ${formatDateTime(run.startedAt)}`}
        // Imported is what this run created; seen is every row in the fetched
        // window, which the 7-day overlap makes the larger number by design. The
        // worker only writes the counts on success, so there is no honest "seen"
        // to show until then.
        stats={[
          { label: "Imported", value: total.toLocaleString("en-NZ") },
          { label: "Seen", value: run.status === "success" ? run.transactionsSynced.toLocaleString("en-NZ") : "—" },
          { label: "Accounts", value: run.accountsSynced.toLocaleString("en-NZ") },
          { label: "Net", value: formatMoney(net, null) },
        ]}
        basePath={withSort(basePath, sort)}
        page={page}
        totalPages={totalPages}
        empty={
          pending
            ? "This sync hasn't finished yet."
            : "No new transactions arrived in this sync."
        }
        notice={
          run.error ? (
            <p className="mb-6 rounded border border-status-critical/30 bg-status-critical/5 p-3 text-sm text-status-critical">
              {run.error}
            </p>
          ) : null
        }
      >
        <TransactionTable items={items} sort={sort} sortBase={basePath} />
      </Listing>
    </>
  );
}
