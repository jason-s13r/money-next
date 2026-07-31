import { notFound } from "next/navigation";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import { describeLifespan, describeRecurrence } from "@/lib/budget/recurrence";
import {
  getBudget,
  getBudgets,
  getBudgetInferenceRuns,
  getCategoryGroups,
  lifespanOf,
  windowTotal,
} from "@/lib/server/queries/budgets";
import { getCategories, getMerchants } from "@/lib/server/queries/lookups";
import { Link } from "@/ui/chrome/workspace-context";
import { AutoRefresh } from "@/ui/primitives/auto-refresh";
import { StatList } from "@/ui/primitives/stat-list";
import { BudgetItems, type ItemRow } from "./items";
import { BudgetLayers } from "./layers";
import { BudgetSettings } from "./settings";

export async function generateMetadata(props: PageProps<"/w/[workspace]/budgets/[budget]">) {
  const budget = await getBudget((await props.params).budget);
  return { title: budget?.name ?? "Budget" };
}

export default async function BudgetPage(props: PageProps<"/w/[workspace]/budgets/[budget]">) {
  const id = (await props.params).budget;
  const budget = await getBudget(id);
  if (!budget) notFound();

  const [groups, categories, merchants, runs, allBudgets] = await Promise.all([
    getCategoryGroups(),
    getCategories(),
    getMerchants(),
    getBudgetInferenceRuns(),
    getBudgets(),
  ]);

  const isLayer = budget.baseBudgetId !== null;
  // The bases a layer can be moved or duplicated onto — every base but the one it
  // already belongs to. Empty for a base, which shows no such controls.
  const otherBases = isLayer
    ? allBudgets
        .filter((b) => b.baseBudgetId === null && b.id !== budget.baseBudgetId)
        .map((b) => ({ id: b.id, name: b.name }))
    : [];

  // A re-infer of this budget in flight: its items are about to be rebuilt by the
  // worker, so keep the page pulling until the run settles and they update.
  const reinferring = runs.some((r) => r.budgetId === id && r.status !== "failed");

  const lifespan = lifespanOf(budget);
  const now = new Date();

  const items: ItemRow[] = budget.items.map((item) => ({
    id: item.id,
    name: item.name,
    amount: item.amount,
    currency: item.currency,
    frequency: item.frequency,
    interval: item.interval,
    // The date input wants `YYYY-MM-DD`, and the action parses the same back.
    anchorDate: item.anchorDate.toISOString().slice(0, 10),
    cadence: describeRecurrence(item),
    groupId: item.groupId,
    groupName: item.groupName,
    categoryId: item.categoryId,
    categoryName: item.categoryName,
    merchantId: item.merchantId,
    merchantName: item.merchantName,
    inferred: item.inferred,
    inferredSource: item.inferredSource,
    basis: item.basis,
  }));

  // For a bounded budget the total over one instance of its window is the figure
  // that means something — "$1,240 over 25 days". A monthly rate for a budget
  // alive three weeks a year is an average over months it does not exist in.
  const window = windowTotal(budget.items, lifespan, now);

  const stats = window
    ? [
        { label: "Over its window", value: formatMoney(-window.spend, null) },
        ...(window.income > 0
          ? [{ label: "Coming in", value: formatMoney(window.income, null) }]
          : []),
        { label: "Window length", value: `${window.days} days` },
        { label: "Items", value: String(budget.items.length) },
      ]
    : [
        {
          label: "Planned out",
          value: `${formatMoney(-monthly(budget.items, "out"), null)}/mo`,
        },
        ...(monthly(budget.items, "in") > 0
          ? [{ label: "Planned in", value: `${formatMoney(monthly(budget.items, "in"), null)}/mo` }]
          : []),
        { label: "Items", value: String(budget.items.length) },
      ];

  return (
    <main className="mx-auto w-full max-w-4xl p-2">
      <h1 className="mt-4 text-lg">{budget.name}</h1>
      <p className="text-sm text-muted">{describeLifespan(lifespan)}</p>

      {isLayer && budget.base ? (
        <p className="mt-1 text-sm text-muted">
          Layer of{" "}
          <Link href={`/budgets/${budget.base.id}`} className="underline">
            {budget.base.name}
          </Link>{" "}
          — its amounts stack on top while this window is live.
        </p>
      ) : null}

      {reinferring ? (
        <>
          <AutoRefresh active />
          <p className="mt-3 rounded-md border border-input bg-muted/30 p-2 text-sm text-muted">
            Re-inferring from your history in the background — the items will update here
            when it’s done.
          </p>
        </>
      ) : null}

      <StatList className="mt-4" stats={stats} />

      <BudgetItems
        budgetId={budget.id}
        items={items}
        groups={groups}
        categories={categories.map((c) => ({ id: c.id, name: c.name, groupName: c.groupName }))}
        merchants={merchants.map((m) => ({ id: m.id, name: m.name }))}
      />

      {/* A base carries its layers; a layer belongs to a base. Only one applies. */}
      {isLayer ? null : <BudgetLayers baseId={budget.id} layers={budget.layers} />}

      <Card className="mt-10">
        <CardHeader>
          <CardTitle className="text-sm">Budget settings</CardTitle>
        </CardHeader>
        <CardContent>
          <BudgetSettings
            origin={budget.origin}
            isLayer={isLayer}
            otherBases={otherBases}
            budget={{
              id: budget.id,
              name: budget.name,
              startsOn: budget.startsOn ? budget.startsOn.toISOString().slice(0, 10) : null,
              endsOn: budget.endsOn ? budget.endsOn.toISOString().slice(0, 10) : null,
              repeatsAnnually: budget.repeatsAnnually,
              forecast: budget.forecast,
            }}
          />
        </CardContent>
      </Card>
    </main>
  );
}

/**
 * A rough monthly rate for an open-ended budget, from the items' own cadences.
 *
 * Only used for the always-on case, where the window helper has nothing to
 * measure. `windowTotal` does the exact expansion where a window exists.
 */
function monthly(items: { amount: number; frequency: string; interval: number }[], side: "in" | "out") {
  const perMonth: Record<string, number> = {
    day: 30.44,
    week: 52 / 12,
    month: 1,
    quarter: 1 / 3,
    year: 1 / 12,
    // A one-off has no rate; it shows in the window total or in the breakdown
    // column it lands in, not in a monthly average that would imply it recurs.
    once: 0,
  };

  return items.reduce((sum, item) => {
    const rate = (perMonth[item.frequency] ?? 0) / Math.max(1, item.interval);
    const value = item.amount * rate;
    if (side === "in") return value > 0 ? sum + value : sum;
    return value < 0 ? sum + value : sum;
  }, 0);
}
