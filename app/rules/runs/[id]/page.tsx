import Link from "next/link";
import { notFound } from "next/navigation";
import { getRuleRun } from "@/lib/server/queries/runs";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { positiveAmountClass } from "@/lib/ui/amount";
import { StatList } from "@/ui/primitives/stat-list";

export const metadata = { title: "Rule run" };

const FIELD_LABEL: Record<string, string> = {
  category: "Category",
  merchant: "Merchant",
  transfer: "Transfer",
};

export default async function RuleRunPage(props: PageProps<"/rules/runs/[id]">) {
  const { id } = await props.params;

  // No integer parse any more: run ids are cuids. An unknown id falls through to
  // the same notFound() the parse used to guard, and the scoped client means an
  // id belonging to another workspace is exactly as unknown as a made-up one.
  const data = await getRuleRun(id);
  if (!data) notFound();
  const { run, applications } = data;

  return (
    <main className="mx-auto w-full max-w-4xl p-2">
      <header className="mb-6">
        <Link href="/rules/runs" className="text-sm text-muted hover:underline">
          ← Rules log
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          Rule run · <span className="capitalize">{run.trigger}</span>
        </h1>
        <p className="mt-1 text-sm text-muted">{formatDateTime(run.startedAt)}</p>
        <StatList
          className="mt-4"
          stats={[
            { label: "Evaluated", value: run.evaluated.toLocaleString("en-NZ") },
            { label: "Categorised", value: run.categorised.toLocaleString("en-NZ") },
            { label: "Merchants", value: run.merchantsSet.toLocaleString("en-NZ") },
            { label: "Transfers", value: run.transfersLinked.toLocaleString("en-NZ") },
            ...(run.errors ? [{ label: "Errored", value: run.errors.toLocaleString("en-NZ") }] : []),
          ]}
        />
      </header>

      {run.error ? (
        <p className="mb-6 rounded border border-status-critical/30 bg-status-critical/5 p-3 text-sm text-status-critical">
          {run.error}
        </p>
      ) : null}

      {applications.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">This run made no edits.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-current/20 text-left">
              <th className="py-2 pr-4 font-medium">Date</th>
              <th className="py-2 pr-4 font-medium">Transaction</th>
              <th className="py-2 pr-4 font-medium">Set</th>
              <th className="py-2 pl-4 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {applications.map((a) => (
              <tr key={a.id} className="border-b border-current/10 align-top">
                <td className="py-2 pr-4 whitespace-nowrap opacity-60">
                  {a.transaction ? formatDate(a.transaction.date) : "—"}
                </td>
                <td className="py-2 pr-4">
                  {a.transaction ? (
                    <Link
                      href={`/transactions/${a.transaction.id}`}
                      className="underline underline-offset-2"
                    >
                      {a.transaction.merchantName ?? a.transaction.description}
                    </Link>
                  ) : (
                    <span className="opacity-50">(deleted transaction)</span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  <span className="mr-2 rounded bg-current/10 px-1.5 py-0.5 text-xs">
                    {FIELD_LABEL[a.field] ?? a.field}
                  </span>
                  {a.field === "transfer" ? (
                    <span className="text-muted">
                      linked to <span className="text-foreground">{a.toLabel}</span>
                    </span>
                  ) : (
                    <span>
                      {a.fromLabel ? (
                        <>
                          <span className="text-muted line-through">{a.fromLabel}</span>{" "}
                          <span className="opacity-40">→</span>{" "}
                        </>
                      ) : null}
                      <span className="font-medium">{a.toLabel}</span>
                    </span>
                  )}
                </td>
                <td
                  className={`py-2 pl-4 text-right font-mono tabular-nums ${a.transaction ? positiveAmountClass(a.transaction.amount) : ""}`}
                >
                  {a.transaction ? formatMoney(a.transaction.amount, a.transaction.currency) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
