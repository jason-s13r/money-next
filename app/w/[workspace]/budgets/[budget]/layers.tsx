"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link, useCanEdit } from "@/ui/chrome/workspace-context";
import { createLayer } from "../actions";
import { LifespanFields } from "../budget-form";
import { NO_ERROR, type BudgetActionState } from "../types";

// A base's layers: the seasonal extras stacked on top of it, and the form to add
// one. A layer holds only the extra a period needs, so it defaults to a window —
// a Christmas, a holiday, a course of treatment — added on while that window is
// live. Shown on the base's own page, because that is where "and on top of this,
// each December…" belongs.

export type LayerRef = { id: string; name: string };

export function BudgetLayers({ baseId, layers }: { baseId: string; layers: LayerRef[] }) {
  const canEdit = useCanEdit();

  if (!canEdit && layers.length === 0) return null;

  return (
    <section className="mt-10">
      <h2 className="text-sm font-medium">Layers</h2>
      <p className="mt-1 text-xs text-muted">
        Extra spending stacked on top of this base while its own dates are live — and
        included when this base is used as a forecast.
      </p>

      {layers.length > 0 ? (
        <ul className="mt-3 flex flex-col divide-y divide-border">
          {layers.map((layer) => (
            <li key={layer.id}>
              <Link
                href={`/budgets/${layer.id}`}
                className="flex items-center justify-between py-2 text-sm hover:opacity-80"
              >
                <span className="truncate">{layer.name}</span>
                <span className="text-xs text-muted">Layer →</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">No layers yet.</p>
      )}

      {canEdit ? <AddLayer baseId={baseId} /> : null}
    </section>
  );
}

/** The collapsible "add a layer" form: a name and a lifespan, defaulting to a
 *  window since that is what a layer almost always is. */
function AddLayer({ baseId }: { baseId: string }) {
  const [state, formAction] = useActionState<BudgetActionState, FormData>(createLayer, NO_ERROR);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="mt-3">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Add a layer
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-4 flex flex-col gap-4 rounded-lg border border-input p-3">
      <input type="hidden" name="baseBudgetId" value={baseId} />

      <label className="flex flex-col gap-1 text-sm">
        Name
        <Input name="name" required autoComplete="off" placeholder="Christmas" />
      </label>

      <LifespanFields
        defaultWindowed
        windowHint="The dates this extra applies. A Christmas layer that repeats every year is added on each December."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Create />
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {state.error ? (
          <p role="alert" className="text-sm text-status-critical">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** Separate so `useFormStatus` reads the form it is rendered inside. */
function Create() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Creating…" : "Create layer"}
    </Button>
  );
}
