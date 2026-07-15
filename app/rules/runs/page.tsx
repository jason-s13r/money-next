import Link from "next/link";
import { getRuleRuns, RULE_RUNS_PER_PAGE } from "@/lib/server/queries/runs";
import { formatDateTime } from "@/lib/format";
import { Pagination, paginate, parsePage } from "@/ui/primitives/pagination";

export const metadata = { title: "Rules log" };

export default async function RuleRunsPage(props: PageProps<"/rules/runs">) {
  const searchParams = await props.searchParams;
  const page = parsePage(searchParams.page);
  const { items, total } = await getRuleRuns(page);

  const totalPages = paginate(
    total,
    page,
    (n) => (n === 1 ? "/rules/runs" : `/rules/runs?page=${n}`),
    RULE_RUNS_PER_PAGE,
  );

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <header className="mb-6">
        <Link href="/rules" className="text-sm text-muted hover:underline">
          ← Rules
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Rules log</h1>
        <p className="mt-1 text-sm text-muted">
          Every rule run that changed something — automatically during a sync, or
          when you pressed Apply now.
        </p>
      </header>

      {items.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">
          No rule runs yet. Runs that don’t change anything aren’t logged.
        </p>
      ) : (
        <>
          <table className="w-full border-collapse text-sm">
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
                    {run._count.applications.toLocaleString("en-NZ")}
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
                    {run.status === "failed" ? (
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

          <Pagination basePath="/rules/runs" page={page} totalPages={totalPages} />
        </>
      )}
    </main>
  );
}
