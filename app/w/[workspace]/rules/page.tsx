import { Link } from "@/ui/chrome/workspace-context";
import { requireWorkspace } from "@/lib/server/auth/session";
import { getDb } from "@/lib/server/db/request";
import {
  getCategories,
  getLabels,
  getMerchants,
  getTransactionTypes,
} from "@/lib/server/queries/lookups";
import { getRuleRuns } from "@/lib/server/queries/runs";
import { readLearnedRules, readTransferAutoLink, type Graph } from "@/lib/server/rules/learning";
import { formatDateTime } from "@/lib/format";
import { TransfersToggle } from "./transfers-toggle";
import { RuleRow } from "@/ui/rules/rule-row";
import type { RuleCatalogs } from "@/ui/rules/rule-editor";
import { AutoRefresh } from "@/ui/primitives/auto-refresh";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata = { title: "Rules" };

// How many recent runs to surface inline; the rest live on /rules/runs.
const RECENT_RUNS = 8;

export default async function RulesPage() {
  // Rules are a standing instruction over everyone's data, so running or
  // changing them is `sync.run`/`enrichment.update` — not a viewer's. The list
  // itself stays readable: a rule is *why* a transaction says what it says.
  const { role } = await requireWorkspace();
  const canEdit = role !== "viewer";

  const db = await getDb();
  // The catalogs are the editor's option lists, so they are only worth fetching
  // for someone who can open it.
  const [doc, categories, merchants, labels, types, runList] = await Promise.all([
    db.ruleDocument.findFirst({ where: { active: true } }),
    getCategories(),
    getMerchants(),
    canEdit ? getLabels() : [],
    canEdit ? getTransactionTypes() : [],
    getRuleRuns(1),
  ]);

  const graph = doc ? (JSON.parse(doc.content) as Graph) : null;
  const rules = graph ? readLearnedRules(graph) : [];
  const transfersOn = graph ? readTransferAutoLink(graph) : false;

  const recentRuns = runList.items.slice(0, RECENT_RUNS);
  // A queued/running backfill is finished by the worker out-of-band; poll while one
  // is in flight so it moves to success/failed on its own (same as /sync).
  const inFlight = runList.items.some((r) => r.status === "queued" || r.status === "running");

  // Resolve output ids to names for display.
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const merchantName = new Map(merchants.map((m) => [m.id, m.name]));

  const catalogs: RuleCatalogs = {
    types: types.map((t) => ({ value: t, label: t })),
    // The group as a hint, matching the category picker on a transaction.
    categories: categories.map((c) => ({
      value: c.id,
      label: c.name,
      ...(c.groupName ? { hint: c.groupName } : {}),
    })),
    merchants: merchants.map((m) => ({ value: m.id, label: m.name })),
    labels: labels.map((l) => ({ value: l.name, label: l.name })),
  };

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <AutoRefresh active={inFlight} />
      <h1 className="sr-only">Rules</h1>

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
          {canEdit ? (
            <>
              No rules yet. Open a transaction you’ve categorised, then use{" "}
              <span className="font-medium">Create rule from this transaction</span> to
              teach one — it’ll apply to similar transactions from then on.
            </>
          ) : (
            // Don't send someone to press a button their role doesn't render.
            <>No rules yet. An owner or editor can teach one from a transaction.</>
          )}
        </p>
      ) : (
        <ul className="divide-y divide-current/10 border-y border-current/10">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              canEdit={canEdit}
              catalogs={catalogs}
              rule={{
                id: rule.id,
                type: rule.match.type,
                tokens: rule.match.tokens,
                structured: rule.match.structured,
                raw: rule.match.raw,
                categoryId: rule.categoryId,
                merchantId: rule.merchantId,
                labelName: rule.labelName,
                categoryLabel: rule.categoryId
                  ? categoryName.get(rule.categoryId) ?? rule.categoryId
                  : null,
                merchantLabel: rule.merchantId
                  ? merchantName.get(rule.merchantId) ?? rule.merchantId
                  : null,
              }}
            />
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-muted">
        Rules are matched top-to-bottom; the first match wins.
        {canEdit ? (
          <>
            {" "}
            <Link href="/transactions/recent" className="underline underline-offset-2">
              Browse transactions
            </Link>{" "}
            to teach more.
          </>
        ) : null}
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
            No rule runs yet.{" "}
            {canEdit
              ? "Press Apply now, or wait for a sync to match something."
              : "A run appears when a sync matches something."}
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
                {run.status === "queued" ? (
                  <span className="text-xs italic text-muted">queued</span>
                ) : run.status === "running" ? (
                  <span className="text-xs text-muted">running…</span>
                ) : run.status === "failed" ? (
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
