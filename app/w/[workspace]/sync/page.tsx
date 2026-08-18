import { getSyncRuns, SYNC_RUNS_PER_PAGE } from "@/lib/server/queries/runs";
import { formatDateTime } from "@/lib/format";
import { requireWorkspace } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import { StatList } from "@/ui/primitives/stat-list";
import { Pagination, paginate, parsePage } from "@/ui/primitives/pagination";
import { AutoRefresh } from "@/ui/primitives/auto-refresh";
import { ConnectBankForm } from "./connect-form";
import { ReplaceTokensForm } from "./replace-form";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata = { title: "Sync history" };

export default async function SyncHistoryPage(props: PageProps<"/w/[workspace]/sync">) {
  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const { items, total } = await getSyncRuns(page);

  // Which token form to offer, if either. Asked as the specific question rather
  // than through `useCanEdit`, which is the coarse viewer/not-viewer split:
  // connecting a bank is `bankLink.create`, and that is owner-only. Both actions
  // re-ask it with `requireRole` — this only decides whether to *offer* them.
  //
  // A REVOKED link is excluded: re-keying one would store a working token on a
  // connection that still would not sync, which is a lie the page would be
  // telling. Un-revoking is a lifecycle decision and has no surface yet.
  const db = await getDb();
  const [{ role }, links] = await Promise.all([
    requireWorkspace(),
    db.bankLink.findMany({
      where: { status: { not: "REVOKED" } },
      select: { id: true, name: true, status: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const isOwner = role === "owner";
  const offerConnect = links.length === 0 && isOwner;

  // Open the re-key form when the newest run failed, rather than making someone
  // find a disclosure while looking at an authentication error. Only on page 1,
  // where "newest" is what the reader is actually seeing.
  const lastFailed = page === 1 && items[0]?.status === "failed";

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
      <AutoRefresh active={inFlight > 0} />
      <header className="mb-6">
        <h1 className="sr-only">Sync history</h1>
        <StatList
          stats={[
            { label: "Total runs", value: total.toLocaleString("en-NZ") },
            { label: "Succeeded", value: succeeded.toLocaleString("en-NZ") },
            { label: "Failed", value: failed.toLocaleString("en-NZ") },
            { label: "In flight", value: inFlight.toLocaleString("en-NZ") },
          ]}
        />
      </header>

      {offerConnect ? <ConnectBankForm /> : null}

      {items.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">No sync runs yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
          <table className="w-full min-w-3xl border-collapse text-sm">
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
          </div>

          <Pagination basePath="/sync" page={page} totalPages={totalPages} />
        </>
      )}

      {/* Below the runs, not above them. Re-keying is a once-a-year repair, and
          it spent its first version as a bordered card floating over the table
          it was meant to be a footnote to. Down here it is a line of small text
          under a rule — and when the newest run failed it opens itself, right
          beneath the error that sent someone looking. */}
      {isOwner && links.length > 0 ? (
        <ReplaceTokensForm links={links} defaultOpen={lastFailed} />
      ) : null}
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
