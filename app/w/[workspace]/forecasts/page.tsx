import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import { getBalanceSummary } from "@/lib/server/metrics/balance";
import { getSpendSummary } from "@/lib/server/metrics/spend";
import { getForecastProjections } from "@/lib/server/metrics/budget/forecast";
import { getBudgets } from "@/lib/server/queries/budgets";
import { getForecasts } from "@/lib/server/queries/forecasts";
import { Link } from "@/ui/chrome/workspace-context";
import { StatList } from "@/ui/primitives/stat-list";
import { ForecastList } from "./forecast-list";

// Forecasts: what the dashboard's projected lines are, and how to change them.
//
// A forecast is one decision — which budget to project — and this page is that
// decision per card, with the answer it produces beside it: when the money runs
// out, and what it burns a month. The answer is computed by the same projection
// the chart draws so this page and the dashboard can never disagree.
//
// A forecast needs a budget to project, so with none written yet the page is the
// offer to make one instead. Nothing is created by rendering it: the dashboard
// simply draws no forward line until someone makes a forecast, because a plan
// nobody agreed to is worse than an honest blank.

export const metadata = { title: "Forecasts" };

const dayFmt = new Intl.DateTimeFormat("en-NZ", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

export default async function ForecastsPage() {
  const [forecasts, budgets] = await Promise.all([getForecasts(), getBudgets()]);

  // A forecast projects a base together with its layers, so only bases are offered
  // — a bare layer is an extra, not a plan you project on its own.
  const bases = budgets.filter((b) => b.baseBudgetId === null);

  if (bases.length === 0) {
    return (
      <main className="mx-auto w-full max-w-3xl p-2">
        <h1 className="mt-4 text-lg">Forecasts</h1>
        <p className="mt-1 text-sm text-muted">
          A forecast projects one base budget — and its seasonal layers — forward from
          today’s balance, so the dashboard can show where the money goes rather than a
          flat average of what you already did.
        </p>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-sm">Make a budget first</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <p className="text-secondary">
              There’s nothing to forecast yet. Infer a budget from your history — or write
              one by hand — and then a forecast is one click over it.
            </p>
            <Link
              href="/budgets/new"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Create a budget →
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  const budgetChoices = bases.map((b) => ({ id: b.id, name: b.name, activeNow: b.activeNow }));

  // The projections are the answer each card is judged by, so they come from the
  // one module that computes them for the chart as well. Skipped entirely when no
  // forecast exists — there is nothing to project.
  const rows =
    forecasts.length === 0
      ? []
      : await (async () => {
          const [balances, spend] = await Promise.all([getBalanceSummary(), getSpendSummary()]);
          const projections = await getForecastProjections(balances, spend);
          const byId = new Map(projections.map((p) => [p.id, p]));

          return forecasts.map((forecast) => {
            const projection = byId.get(forecast.id);
            return {
              ...forecast,
              depletion:
                projection?.depletionDay != null
                  ? `runs dry ${dayFmt.format(new Date(`${projection.depletionDay}T00:00:00Z`))}`
                  : projection && projection.months === Infinity
                    ? "never runs dry at this rate"
                    : "still solvent in two years",
              // Signed the way money is everywhere else here: negative is money out.
              // A forecast over a budget with a wage often nets positive, worth seeing.
              monthlyNet:
                projection?.monthlyBurn == null
                  ? "—"
                  : `${formatMoney(-projection.monthlyBurn, null)}/mo net`,
              blendedDays: projection?.blendedDays ?? 0,
            };
          });
        })();

  const soonest = rows.find((r) => r.depletion.startsWith("runs dry"));

  return (
    <main className="mx-auto w-full max-w-3xl p-2">
      <h1 className="sr-only">Forecasts</h1>

      <div className="mt-4 mb-4">
        <StatList
          stats={[
            { label: "Forecasts", value: String(forecasts.length) },
            { label: "Bases to choose from", value: String(bases.length) },
            {
              label: "First to run dry",
              value: soonest ? soonest.depletion.replace("runs dry ", "") : "None",
            },
          ]}
        />
      </div>

      <p className="mb-4 text-sm text-muted">
        Each forecast projects one base — together with its seasonal layers, added on
        while their windows are live — as one line on the{" "}
        <Link href="/" className="underline underline-offset-2 hover:text-foreground">
          dashboard
        </Link>{" "}
        and one runway tile beside it. To vary a projection — drop the income for a
        worst-case line, thin the spending for an emergency floor — duplicate its base
        and edit the copy.
      </p>

      <ForecastList forecasts={rows} budgets={budgetChoices} />
    </main>
  );
}
