"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCanEdit } from "@/ui/chrome/workspace-context";
import { createForecast, deleteForecast, moveForecast, updateForecast } from "./actions";
import { NO_ERROR, type BudgetActionState } from "../budgets/types";

// One card per forecast: which base it projects, and what that works out to.
//
// The one control is deliberately plain — a base picker and a name — because the
// interesting part is not the form, it is that a forecast is just a base (with its
// seasonal layers) seen from the side. There is no income toggle: a worst-case or
// emergency line is a base with its income items removed, made by duplicating and
// editing, not a flag here that would quietly mean something different from what the
// budget says.

export type ForecastRow = {
  id: string;
  name: string;
  color: string;
  budgetId: string;
  /** Pre-built on the server: "runs dry 2 Oct 2026", or why it doesn't. */
  depletion: string;
  /** Net per month, pre-formatted and signed the way money is shown elsewhere. */
  monthlyNet: string;
  /** Days ahead the budget does not cover, which run at the historic rate. */
  blendedDays: number;
};

export type BudgetChoice = { id: string; name: string; activeNow: boolean };

export function ForecastList({
  forecasts,
  budgets,
}: {
  forecasts: ForecastRow[];
  budgets: BudgetChoice[];
}) {
  const canEdit = useCanEdit();

  return (
    <div className="flex flex-col gap-4">
      {forecasts.map((forecast, index) => (
        <ForecastCard
          key={forecast.id}
          forecast={forecast}
          budgets={budgets}
          canEdit={canEdit}
          isFirst={index === 0}
          isLast={index === forecasts.length - 1}
        />
      ))}

      {canEdit ? <NewForecast budgets={budgets} /> : null}
    </div>
  );
}

/** The budget picker, shared by the edit and create forms. A native select: the
 *  choice is one of a short list, and the server re-resolves whatever id is posted. */
function BudgetSelect({ budgets, value }: { budgets: BudgetChoice[]; value?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      Base to project
      <select
        name="budgetId"
        defaultValue={value ?? budgets[0]?.id ?? ""}
        required
        className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
      >
        {budgets.map((budget) => (
          <option key={budget.id} value={budget.id}>
            {budget.name}
            {budget.activeNow ? "" : " (dormant today)"}
          </option>
        ))}
      </select>
    </label>
  );
}

function ForecastCard({
  forecast,
  budgets,
  canEdit,
  isFirst,
  isLast,
}: {
  forecast: ForecastRow;
  budgets: BudgetChoice[];
  canEdit: boolean;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [state, formAction] = useActionState<BudgetActionState, FormData>(
    updateForecast,
    NO_ERROR,
  );

  const budgetName = budgets.find((b) => b.id === forecast.budgetId)?.name ?? "a budget";

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="flex items-center gap-2">
            {/* The swatch is the join between this card, its line on the chart and
                its runway tile — the colour is stored on the row precisely so it
                survives a neighbour being deleted. */}
            <span
              className="inline-block size-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: forecast.color }}
            />
            <span className="font-medium">{forecast.name}</span>
          </span>
          <span className="font-mono text-sm tabular-nums text-secondary">
            {forecast.monthlyNet} · {forecast.depletion}
          </span>
        </div>

        {canEdit ? (
          <form action={formAction} className="flex flex-col gap-4">
            <input type="hidden" name="forecastId" value={forecast.id} />

            <label className="flex flex-col gap-1 text-sm">
              Name
              <Input name="name" defaultValue={forecast.name} required autoComplete="off" />
            </label>

            <BudgetSelect budgets={budgets} value={forecast.budgetId} />

            {forecast.blendedDays > 0 ? (
              <p className="text-xs text-muted">
                {forecast.blendedDays.toLocaleString("en-NZ")} of the next two years aren’t
                covered by this budget and run at your historic spending rate.
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Save />
              {state.error ? (
                <p role="alert" className="text-sm text-status-critical">
                  {state.error}
                </p>
              ) : null}
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted">Projects {budgetName}.</p>
        )}

        {canEdit ? (
          // Outside the form above, because a form cannot nest inside another.
          <div className="flex flex-wrap items-center gap-1 border-t border-current/20 pt-3">
            <MoveButton forecastId={forecast.id} direction="up" disabled={isFirst} />
            <MoveButton forecastId={forecast.id} direction="down" disabled={isLast} />
            <span className="flex-1" />
            <DeleteButton forecastId={forecast.id} name={forecast.name} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MoveButton({
  forecastId,
  direction,
  disabled,
}: {
  forecastId: string;
  direction: "up" | "down";
  disabled: boolean;
}) {
  const [, formAction] = useActionState<BudgetActionState, FormData>(moveForecast, NO_ERROR);
  const Icon = direction === "up" ? ChevronUpIcon : ChevronDownIcon;

  return (
    <form action={formAction}>
      <input type="hidden" name="forecastId" value={forecastId} />
      <input type="hidden" name="direction" value={direction} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-label={`Move ${direction}`}
      >
        <Icon className="size-4" />
      </Button>
    </form>
  );
}

function DeleteButton({ forecastId, name }: { forecastId: string; name: string }) {
  const [, formAction] = useActionState<BudgetActionState, FormData>(deleteForecast, NO_ERROR);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-muted hover:text-status-critical"
        onClick={() => setConfirming(true)}
      >
        Delete
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="forecastId" value={forecastId} />
      {/* Worth saying: the budget it projected is not going anywhere. A forecast is
          a view of it, and deleting a view is cheap to undo by hand. */}
      <span className="text-sm">Remove “{name}”? Its budget is kept.</span>
      <Pending variant="destructive">Remove</Pending>
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        Keep it
      </Button>
    </form>
  );
}

/** Adding a forecast: a name and the one budget it projects. */
function NewForecast({ budgets }: { budgets: BudgetChoice[] }) {
  const [state, formAction] = useActionState<BudgetActionState, FormData>(
    createForecast,
    NO_ERROR,
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          New forecast
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Name
            <Input name="name" required autoComplete="off" defaultValue="Forecast" />
          </label>
          <BudgetSelect budgets={budgets} />
          <div className="flex flex-wrap items-center gap-2">
            <Pending variant="default">Create forecast</Pending>
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
      </CardContent>
    </Card>
  );
}

function Save() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Saving…" : "Save changes"}
    </Button>
  );
}

/** A submit button that says what it is doing. Separate so `useFormStatus` reads
 *  the form it is rendered inside. */
function Pending({
  children,
  variant,
}: {
  children: React.ReactNode;
  variant: "default" | "destructive";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {pending ? "Working…" : children}
    </Button>
  );
}
