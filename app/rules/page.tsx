import Link from "next/link";
import { getDb } from "@/lib/server/db";
import { getCategories, getMerchants } from "@/lib/server/queries/lookups";
import { getRuleRuns } from "@/lib/server/queries/runs";
import { readLearnedRules, readTransferAutoLink, type Graph } from "@/lib/server/rules/learning";
import { formatDateTime } from "@/lib/format";
import { removeRule } from "./actions";
import { ApplyRulesButton } from "./apply-rules-button";
import { TransfersToggle } from "./transfers-toggle";
import { RuleOutputs } from "@/ui/rules/rule-output";

export const metadata = { title: "Rules" };

// How many recent runs to surface inline; the rest live on /rules/runs.
const RECENT_RUNS = 8;

export default async function RulesPage() {
  const db = await getDb();
  const [doc, categories, merchants, runList] = await Promise.all([
    db.ruleDocument.findFirst({ where: { active: true } }),
    getCategories(),
    getMerchants(),
    getRuleRuns(1),
  ]);

  const graph = doc ? (JSON.parse(doc.content) as Graph) : null;
  const rules = graph ? readLearnedRules(graph) : [];
  const transfersOn = graph ? readTransferAutoLink(graph) : false;

  const recentRuns = runList.items.slice(0, RECENT_RUNS);

  // Resolve output ids to names for display.
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const merchantName = new Map(merchants.map((m) => [m.id, m.name]));

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h1 className="text-2xl font-semibold">Rules</h1>
        </div>
        <ApplyRulesButton disabled={rules.length === 0 && !transfersOn} />
      </header>

      <section className="mb-8 flex items-center justify-between gap-4 rounded border border-current/15 px-4 py-3">
        <div>
          <p className="text-sm font-medium">Auto-link transfers</p>
          <p className="text-xs text-muted">
            When a transaction Akahu tags as a transfer has one clear opposite leg,
            group them automatically.
          </p>
        </div>
        <TransfersToggle enabled={transfersOn} />
      </section>

      {rules.length === 0 ? (
        <p className="rounded border border-dashed border-current/20 px-4 py-8 text-center text-sm text-muted">
          No rules yet. Open a transaction you’ve categorised, then use{" "}
          <span className="font-medium">Create rule from this transaction</span> to
          teach one — it’ll apply to similar transactions from then on.
        </p>
      ) : (
        <ul className="divide-y divide-current/10 border-y border-current/10">
          {rules.map((rule) => {
            const cat = rule.categoryId ? categoryName.get(rule.categoryId) ?? rule.categoryId : null;
            const mer = rule.merchantId ? merchantName.get(rule.merchantId) ?? rule.merchantId : null;
            return (
              <li key={rule.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">
                  <span className="opacity-50">When</span>
                  {rule.match.type ? (
                    <span className="rounded bg-current/10 px-1.5 py-0.5 font-mono text-xs">
                      {rule.match.type}
                    </span>
                  ) : null}
                  {rule.match.structured ? (
                    rule.match.tokens.map((t) => (
                      <span key={t} className="rounded bg-current/10 px-1.5 py-0.5 font-mono text-xs">
                        {t}
                      </span>
                    ))
                  ) : (
                    <code className="rounded bg-current/10 px-1.5 py-0.5 text-xs">{rule.match.raw}</code>
                  )}
                  <span className="opacity-50">→</span>
                  <RuleOutputs categoryName={cat} merchantName={mer} />
                </div>
                <form action={removeRule.bind(null, rule.id)}>
                  <button
                    type="submit"
                    className="text-xs text-status-critical opacity-70 transition-opacity hover:opacity-100"
                    aria-label="Delete rule"
                  >
                    Delete
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-4 text-xs text-muted">
        Rules are matched top-to-bottom; the first match wins.{" "}
        <Link href="/transactions/recent" className="underline underline-offset-2">
          Browse transactions
        </Link>{" "}
        to teach more.
      </p>

      <section className="mt-12">
        <div className="flex items-center justify-between border-b border-current/20 pb-2">
          <h2 className="text-sm font-medium opacity-60">Execution log</h2>
          {runList.total > recentRuns.length ? (
            <Link
              href="/rules/runs"
              className="text-xs text-muted underline-offset-2 hover:underline"
            >
              View all {runList.total.toLocaleString("en-NZ")} →
            </Link>
          ) : null}
        </div>

        {recentRuns.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">
            No rule runs yet. A run is logged whenever the rules change something —
            during a sync, or when you press Apply now.
          </p>
        ) : (
          <ul className="divide-y divide-current/10">
            {recentRuns.map((run) => (
              <li key={run.id} className="flex items-center gap-3 py-2 text-sm">
                <Link
                  href={`/rules/runs/${run.id}`}
                  className="font-mono text-xs tabular-nums underline-offset-2 hover:underline"
                >
                  {formatDateTime(run.startedAt)}
                </Link>
                <span className="text-xs capitalize text-muted">{run.trigger}</span>
                {run.status === "failed" ? (
                  <span className="text-xs text-status-critical">failed</span>
                ) : run.errors > 0 ? (
                  <span className="text-xs text-status-critical">{run.errors} errored</span>
                ) : null}
                <span className="ml-auto text-xs text-muted tabular-nums">
                  {run._count.changes.toLocaleString("en-NZ")}{" "}
                  {run._count.changes === 1 ? "edit" : "edits"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
