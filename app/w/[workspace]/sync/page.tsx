import { getSyncRuns, SYNC_RUNS_PER_PAGE } from "@/lib/server/queries/runs";
import { formatDateTime } from "@/lib/format";
import { StatList } from "@/ui/primitives/stat-list";
import { Pagination, paginate, parsePage } from "@/ui/primitives/pagination";
import { FullSyncButton } from "./full-sync-button";
import { SyncAutoRefresh } from "./auto-refresh";

export const metadata = { title: "Sync history" };

export default async function SyncHistoryPage(props: PageProps<"/w/[workspace]/sync">) {
  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const { items, total } = await getSyncRuns(page);

  const totalPages = await paginate(total, page, (n) =>
    n === 1 ? "/sync" : `/sync?page=${n}`,
    SYNC_RUNS_PER_PAGE,
  );

  const succeeded = items.filter((r) => r.status === "success").length;
  const failed = items.filter((r) => r.status === "failed").length;
  // Queued (waiting for the worker) and running (claimed by it) are both "in
  // flight" — count them together, and let that also drive the auto-refresh: while
  // anything is pending the page pulls the result the worker lands out-of-band.
  const inFlight = items.filter((r) => r.status === "queued" || r.status === "running").length;

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <SyncAutoRefresh active={inFlight > 0} />
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Sync history</h1>
          <StatList
            className="mt-4"
            stats={[
              { label: "Total runs", value: total.toLocaleString("en-NZ") },
              { label: "Succeeded", value: succeeded.toLocaleString("en-NZ") },
              { label: "Failed", value: failed.toLocaleString("en-NZ") },
              { label: "In flight", value: inFlight.toLocaleString("en-NZ") },
            ]}
          />
        </div>
        <FullSyncButton />
      </header>

      {items.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">
          No sync runs yet. Run `pnpm db:sync`.
        </p>
      ) : (
        <>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-current/20 text-left">
                <th className="py-2 pr-4 font-medium">Started</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 text-right font-medium">Accounts</th>
                <th className="py-2 pr-4 text-right font-medium">Transactions</th>
                <th className="py-2 pr-4 font-medium">Duration</th>
                <th className="py-2 pr-4 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {items.map((run) => (
                <tr key={run.id} className="border-b border-current/10">
                  <td className="py-2 pr-4 font-mono tabular-nums">
                    {formatDateTime(run.startedAt)}
                  </td>
                  <td className="py-2 pr-4">
                    <SyncStatusBadge status={run.status} />
                  </td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">
                    {run.accountsSynced.toLocaleString("en-NZ")}
                  </td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">
                    {run.transactionsSynced.toLocaleString("en-NZ")}
                  </td>
                  <td className="py-2 pr-4 font-mono tabular-nums">
                    {run.finishedAt ? formatDuration(run.startedAt, run.finishedAt) : "—"}
                  </td>
                  <td
                    className="max-w-xs truncate py-2 pr-4 text-status-critical"
                    title={run.error ?? undefined}
                  >
                    {run.error ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <Pagination basePath="/sync" page={page} totalPages={totalPages} />
        </>
      )}
    </main>
  );
}

function SyncStatusBadge({ status }: { status: string }) {
  const classes =
    status === "success"
      ? "text-status-good"
      : status === "failed"
        ? "text-status-critical"
        : status === "running"
          ? "opacity-60"
          : // queued: waiting for the worker
            "opacity-50 italic";
  return <span className={`font-medium ${classes}`}>{status}</span>;
}

function formatDuration(start: Date, end: Date) {
  const ms = end.getTime() - start.getTime();
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}
