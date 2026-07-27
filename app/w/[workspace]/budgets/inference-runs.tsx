"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { AutoRefresh } from "@/ui/primitives/auto-refresh";
import { useCanEdit } from "@/ui/chrome/workspace-context";
import { clearInferenceRun, retryInferenceRun } from "./actions";
import { NO_ERROR, type BudgetActionState } from "./types";
import type { InferenceRunView } from "@/lib/server/queries/budgets";

// The "being created" list: budget inferences the worker is chewing on, plus any
// that failed and are worth telling the reader about.
//
// While any run is still queued or running, `<AutoRefresh>` pulls the page every few
// seconds — the worker finishes in another process and can't revalidate this one, so
// a settled run only shows up on the next pull. A finished create just becomes a
// budget in the list below; a failure lingers here, with its reason, until dismissed.

const relative = (startedAt: number): string => {
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  return mins === 1 ? "1 minute ago" : `${mins} minutes ago`;
};

export function InferenceRuns({ runs }: { runs: InferenceRunView[] }) {
  const canEdit = useCanEdit();
  if (runs.length === 0) return null;

  const active = runs.some((r) => r.status !== "failed");

  return (
    <section className="mb-8">
      <AutoRefresh active={active} />
      <h2 className="text-xs text-muted">Being created</h2>
      <ul className="mt-1 flex flex-col divide-y divide-border">
        {runs.map((run) => (
          <li
            key={run.id}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <span className="truncate">
                  {run.budgetName
                    ? `Re-inferring “${run.budgetName}”`
                    : "Inferring a new budget"}
                </span>
                <StatusBadge status={run.status} />
              </span>
              <span className="text-xs text-muted">
                {run.status === "failed" && run.error
                  ? run.error
                  : `started ${relative(run.startedAt)}`}
              </span>
            </span>

            {canEdit ? (
              <span className="flex shrink-0 items-center gap-1">
                {/* Retry only makes sense once a run has actually failed; Clear is
                    offered on any of them, so a run stalled with no worker — or one
                    wedged because a worker died — can be taken off the list too. */}
                {run.status === "failed" ? <Retry runId={run.id} /> : null}
                <Clear runId={run.id} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusBadge({ status }: { status: InferenceRunView["status"] }) {
  if (status === "failed") {
    return <span className="text-xs text-status-critical">failed</span>;
  }
  // Queued and running read the same to a person: it is working on it.
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
      working…
    </span>
  );
}

function Retry({ runId }: { runId: string }) {
  const [, formAction] = useActionState<BudgetActionState, FormData>(retryInferenceRun, NO_ERROR);
  return (
    <form action={formAction}>
      <input type="hidden" name="runId" value={runId} />
      <SubmitGhost pendingLabel="…" label="Retry" />
    </form>
  );
}

function Clear({ runId }: { runId: string }) {
  const [, formAction] = useActionState<BudgetActionState, FormData>(clearInferenceRun, NO_ERROR);
  return (
    <form action={formAction}>
      <input type="hidden" name="runId" value={runId} />
      <SubmitGhost pendingLabel="…" label="Clear" />
    </form>
  );
}

function SubmitGhost({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="ghost"
      size="sm"
      disabled={pending}
      className="text-muted hover:text-foreground"
    >
      {pending ? pendingLabel : label}
    </Button>
  );
}
