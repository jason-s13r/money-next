import { Link } from "@/ui/chrome/workspace-context";
import { getRuleRuns, RULE_RUNS_PER_PAGE } from "@/lib/server/queries/runs";
import { formatDateTime } from "@/lib/format";
import { Pagination, paginate, parsePage } from "@/ui/primitives/pagination";
import { AutoRefresh } from "@/ui/primitives/auto-refresh";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata = { title: "Rules log" };

export default async function RuleRunsPage(props: PageProps<"/w/[workspace]/rules/runs">) {
  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const { items, total } = await getRuleRuns(page);

  const totalPages = await paginate(
    total,
    page,
    (n) => (n === 1 ? "/rules/runs" : `/rules/runs?page=${n}`),
    RULE_RUNS_PER_PAGE,
  );

  const inFlight = items.some((r) => r.status === "queued" || r.status === "running");

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <AutoRefresh active={inFlight} />
      <header className="mb-6">
        <h1 className="sr-only">Rules log</h1>
        <p className="text-sm text-muted">
          Every time you pressed Apply now, and every automatic sync that changed
          something.
        </p>
      </header>

      {items.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">
          No rule runs yet. Press Apply now, or wait for a sync to match something.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
          <table className="w-full min-w-3xl border-collapse text-sm">
            <thead>
              <tr className="border-b border-current/20 text-left">
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Trigger</th>
                <th className="py-2 pr-4 text-right font-medium">Edits</th>
                <th className="py-2 pr-4 text-right font-medium">Category</th>
                <th className="py-2 pr-4 text-right font-medium">Merchant</th>
                <th className="py-2 pr-4 text-right font-medium">Transfers</th>
                <th className="py-2 pr-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((run) => (
                <tr key={run.id} className="border-b border-current/10">
                  <td className="py-2 pr-4">
                    <Link
                      href={`/rules/runs/${run.id}`}
                      className="font-mono tabular-nums underline underline-offset-2"
                    >
                      {formatDateTime(run.startedAt)}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 capitalize">{run.trigger}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">
                    {run._count.changes.toLocaleString("en-NZ")}
                  </td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums opacity-70">
                    {run.categorised.toLocaleString("en-NZ")}
                  </td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums opacity-70">
                    {run.merchantsSet.toLocaleString("en-NZ")}
                  </td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums opacity-70">
                    {run.transfersLinked.toLocaleString("en-NZ")}
                  </td>
                  <td className="py-2 pr-4">
                    {run.status === "queued" ? (
                      <span className="italic opacity-50">queued</span>
                    ) : run.status === "running" ? (
                      <span className="opacity-60">running…</span>
                    ) : run.status === "failed" ? (
                      <span className="font-medium text-status-critical">failed</span>
                    ) : run.errors > 0 ? (
                      <span className="text-status-critical">{run.errors} errored</span>
                    ) : (
                      <span className="text-status-good">ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <Pagination basePath="/rules/runs" page={page} totalPages={totalPages} />
        </>
      )}
    </main>
  );
}
