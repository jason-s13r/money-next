import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import { describeLifespan } from "@/lib/budget/recurrence";
import {
  getBudgets,
  getBudgetInferenceRuns,
  lifespanOf,
  type BudgetSummary,
} from "@/lib/server/queries/budgets";
import { Link } from "@/ui/chrome/workspace-context";
import { StatList } from "@/ui/primitives/stat-list";
import { InferenceRuns } from "./inference-runs";

// Every budget in the workspace, split by whether it is doing anything today.
//
// That split is the first question once seasonal budgets exist: a list that mixes
// "the rent budget, running now" with "the Christmas budget, dormant until
// December" invites the reader to add up numbers that are not simultaneously
// true. Monthly figures are an average over the coming year, so a budget that is
// only alive for three weeks reads as the small share of a year it really is.

export const metadata = { title: "Budgets" };

function BudgetRow({ budget, layer = false }: { budget: BudgetSummary; layer?: boolean }) {
  return (
    <li>
      <Link
        href={`/budgets/${budget.slug}`}
        className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 hover:opacity-80${
          // A layer sits indented under its base, so it reads as an extra on top.
          layer ? " pl-4" : ""
        }`}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate">{budget.name}</span>
            {layer ? <Badge variant="outline">Layer</Badge> : null}
            {budget.origin === "inferred" ? (
              // Says where the numbers came from, so nobody mistakes a guess for
              // a decision they made.
              <Badge variant="secondary">From history</Badge>
            ) : null}
          </span>
          <span className="text-xs text-muted">
            {describeLifespan(lifespanOf(budget))} ·{" "}
            {budget.items === 1 ? "1 item" : `${budget.items} items`}
          </span>
        </span>

        <span className="flex shrink-0 gap-4 font-mono text-sm tabular-nums">
          {budget.monthlyIn > 0 ? (
            <span className="text-status-good">+{formatMoney(budget.monthlyIn, null)}</span>
          ) : null}
          <span>{formatMoney(-budget.monthlyOut, null)}</span>
          <span className="text-muted">/mo</span>
        </span>
      </Link>
    </li>
  );
}

/** A base row followed by its layers, indented. */
function BudgetGroup({ base, layers }: { base: BudgetSummary; layers: BudgetSummary[] }) {
  return (
    <>
      <BudgetRow budget={base} />
      {layers.map((layer) => (
        <BudgetRow key={layer.id} budget={layer} layer />
      ))}
    </>
  );
}

export default async function BudgetsPage() {
  const [budgets, runs] = await Promise.all([getBudgets(), getBudgetInferenceRuns()]);

  // Layers hang under their base, so the two sections list *bases* and each base
  // brings its own layers along.
  const bases = budgets.filter((b) => b.baseBudgetId === null);
  const layersByBase = new Map<string, BudgetSummary[]>();
  for (const b of budgets) {
    if (!b.baseBudgetId) continue;
    const list = layersByBase.get(b.baseBudgetId) ?? [];
    list.push(b);
    layersByBase.set(b.baseBudgetId, list);
  }
  const activeBases = bases.filter((b) => b.activeNow);
  const dormantBases = bases.filter((b) => !b.activeNow);

  // How many budgets apply *today* — the header's one live count.
  const active = budgets.filter((b) => b.activeNow);

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <h1 className="sr-only">Budgets</h1>

      <div className="mt-4 mb-4 flex flex-wrap items-end justify-between gap-3">
        <StatList
          stats={[
            { label: "Budgets", value: budgets.length.toLocaleString("en-NZ") },
            { label: "Active now", value: active.length.toLocaleString("en-NZ") },
          ]}
        />

        <div className="flex gap-2">
          {/* Base UI composes with `render`, not `asChild` — see the sidebar. And
              `nativeButton={false}`, because these render an anchor: leaving it
              true tells Base UI to apply native button semantics to something
              that isn't one, which it warns about and which breaks the anchor's
              own keyboard and context-menu behaviour. */}
          {budgets.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href="/budgets/breakdown" />}
            >
              Budget vs actual
            </Button>
          ) : null}
          <Button size="sm" nativeButton={false} render={<Link href="/budgets/new" />}>
            New budget
          </Button>
        </div>
      </div>

      <InferenceRuns runs={runs} />

      {budgets.length === 0 && runs.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">
          No budgets yet. A budget is a set of intended transactions — what you mean to
          earn and spend, and how often — so the breakdown can show the plan beside
          what actually happened.
        </p>
      ) : budgets.length === 0 ? null : (
        <>
          {activeBases.length > 0 ? (
            <section>
              <h2 className="text-xs text-muted">Active now</h2>
              <ul className="flex flex-col divide-y divide-border">
                {activeBases.map((base) => (
                  <BudgetGroup key={base.id} base={base} layers={layersByBase.get(base.id) ?? []} />
                ))}
              </ul>
            </section>
          ) : null}

          {dormantBases.length > 0 ? (
            <section className="mt-8">
              <h2 className="text-xs text-muted">Scheduled and past</h2>
              <ul className="flex flex-col divide-y divide-border">
                {dormantBases.map((base) => (
                  <BudgetGroup key={base.id} base={base} layers={layersByBase.get(base.id) ?? []} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
