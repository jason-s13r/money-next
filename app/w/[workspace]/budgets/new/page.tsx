import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { INFER_MONTHS } from "@/lib/budget/detect";
import { BudgetForm } from "../budget-form";
import { InferButton } from "./infer-button";

// Starting a budget, two ways.
//
// Inferring from history is offered first and deliberately: typing a household's
// whole financial life into a form is an hour of work most people will not finish,
// and nearly all of it is already in the transaction table. The inference reads that
// history with a local AI, which is slow, so it runs in the background — the button
// only sets it going and the finished budget turns up on the budgets list. The blank
// form stays for the budgets history cannot know about — a holiday, a plan to spend
// differently than you have been.

export const metadata = { title: "New budget" };

export default function NewBudgetPage() {
  return (
    <main className="mx-auto w-full max-w-2xl p-2">
      <h1 className="sr-only">New budget</h1>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Infer a budget with AI</CardTitle>
          <CardDescription>
            Read the last {INFER_MONTHS} months of transactions with a local AI and build a
            budget from them — the recurring bills, the pay, the habits. It runs in the
            background and can take a minute or two; check back on your budgets shortly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InferButton />
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Or start empty</CardTitle>
          <CardDescription>
            For a budget your history cannot know about — Christmas, a trip, or a plan to
            spend differently than you have been.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BudgetForm />
        </CardContent>
      </Card>
    </main>
  );
}
