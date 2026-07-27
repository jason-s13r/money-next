"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { useCanEdit } from "@/ui/chrome/workspace-context";
import { startBudgetInference } from "../actions";
import { NO_ERROR, type BudgetActionState } from "../types";

/** Kick off a background AI inference and return to the budgets list, where the run
 *  shows as "being created". Not a link: it enqueues work, which a server action
 *  must do, and a public POST is re-gated server-side regardless of this button. */
export function InferButton() {
  const canEdit = useCanEdit();
  const [state, formAction] = useActionState<BudgetActionState, FormData>(
    startBudgetInference,
    NO_ERROR,
  );

  if (!canEdit) {
    return <p className="text-sm text-muted">Your role can read budgets but not create them.</p>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Submit />
      <p className="text-xs text-muted">
        Uses your configured local AI to read your history. You’ll come back to the budgets
        list while it works.
      </p>
      {state.error ? (
        <p role="alert" className="text-sm text-status-critical">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="self-start">
      {pending ? "Starting…" : "Infer a budget with AI"}
    </Button>
  );
}
