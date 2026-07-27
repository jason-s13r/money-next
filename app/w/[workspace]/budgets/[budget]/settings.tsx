"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { useCanEdit } from "@/ui/chrome/workspace-context";
import {
  deleteBudget,
  duplicateBudget,
  moveLayerToBase,
  refineBudgetTowardActuals,
} from "../actions";
import { reinferBudget } from "../../forecasts/actions";
import { BudgetForm, type BudgetFormValues } from "../budget-form";
import { NO_ERROR, type BudgetActionState } from "../types";

export type BaseChoice = { id: string; name: string };

// Renaming a budget, changing when it applies, copying it, refreshing it from
// history, and deleting it.
//
// Down the bottom of the page and inside a card, because none of it is what
// somebody came here to do — the items are. Deleting asks first: a budget is
// hand-typed work with no undo, unlike almost everything else in this app, which
// can be re-synced from the bank.

export function BudgetSettings({
  budget,
  origin,
  isLayer,
  otherBases,
}: {
  budget: BudgetFormValues;
  origin: string;
  /** Whether this budget is a layer, which unlocks the move-to-base control. */
  isLayer: boolean;
  /** The bases a layer can be moved or duplicated onto (all but its current one). */
  otherBases: BaseChoice[];
}) {
  const canEdit = useCanEdit();
  if (!canEdit) {
    return <p className="text-sm text-muted">Your role can read budgets but not change them.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <BudgetForm budget={budget} />

      {/* Only offered on a budget that came from history in the first place.
          Re-inferring one somebody typed would replace nothing (they have no
          inferred rows) while implying it might replace everything; and refining
          one they wrote toward "actuals" second-guesses a figure they chose. */}
      {origin === "inferred" ? (
        <>
          <ReinferButton budgetId={budget.id} />
          <RefineButton budgetId={budget.id} />
        </>
      ) : null}

      {/* A layer can be re-homed onto another base, or copied onto one — how the
          same seasonal plan carries from one base to the next. */}
      {isLayer && otherBases.length > 0 ? (
        <MoveLayer budgetId={budget.id} otherBases={otherBases} />
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-current/20 pt-4">
        <DuplicateButton budgetId={budget.id} />
        <DeleteButton budgetId={budget.id} name={budget.name} />
      </div>
    </div>
  );
}

/**
 * Move this layer onto another base, or duplicate it onto one.
 *
 * Two buttons over one base picker: moving re-homes the layer (it leaves this
 * base), duplicating leaves it here and copies it onto the chosen base. Both post
 * the target `baseBudgetId`, which the server re-resolves and refuses if it is not
 * a real base.
 */
function MoveLayer({ budgetId, otherBases }: { budgetId: string; otherBases: BaseChoice[] }) {
  const [moveState, moveAction] = useActionState<BudgetActionState, FormData>(
    moveLayerToBase,
    NO_ERROR,
  );
  const [copyState, copyAction] = useActionState<BudgetActionState, FormData>(
    duplicateBudget,
    NO_ERROR,
  );
  const [baseId, setBaseId] = useState(otherBases[0]?.id ?? "");
  const error = moveState.error || copyState.error;

  return (
    <div className="flex flex-col gap-2 border-t border-current/20 pt-4">
      <p className="text-sm text-muted">Move or copy this layer onto another base.</p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={baseId}
          onChange={(event) => setBaseId(event.target.value)}
          className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
          aria-label="Base"
        >
          {otherBases.map((base) => (
            <option key={base.id} value={base.id}>
              {base.name}
            </option>
          ))}
        </select>

        {/* Each button carries the same picked base id into its own action. */}
        <form action={moveAction}>
          <input type="hidden" name="budgetId" value={budgetId} />
          <input type="hidden" name="baseBudgetId" value={baseId} />
          <Pending variant="outline">Move here</Pending>
        </form>
        <form action={copyAction}>
          <input type="hidden" name="budgetId" value={budgetId} />
          <input type="hidden" name="baseBudgetId" value={baseId} />
          <Pending variant="outline">Duplicate here</Pending>
        </form>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-status-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Refresh the untouched guesses from the last two years, leaving anything
 *  hand-edited exactly as it is — which is what the `inferred` flag is for. */
function ReinferButton({ budgetId }: { budgetId: string }) {
  const [state, formAction] = useActionState<BudgetActionState, FormData>(
    reinferBudget,
    NO_ERROR,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2 border-t border-current/20 pt-4">
      <input type="hidden" name="budgetId" value={budgetId} />
      <p className="text-sm text-muted">
        Rebuild the items still marked “from history” out of the last two years of
        transactions. Anything you have edited is left alone.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Pending variant="outline">Re-infer from history</Pending>
        {state.error ? (
          <p role="alert" className="text-sm text-status-critical">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** Pull each item's amount halfway to what has actually been spent since — the
 *  maintenance counterpart to re-inferring. Keeps the items; moves the figures. */
function RefineButton({ budgetId }: { budgetId: string }) {
  const [state, formAction] = useActionState<BudgetActionState, FormData>(
    refineBudgetTowardActuals,
    NO_ERROR,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2 border-t border-current/20 pt-4">
      <input type="hidden" name="budgetId" value={budgetId} />
      <p className="text-sm text-muted">
        Nudge each item’s amount halfway toward what you have actually spent on it over
        the last few months, without changing the items themselves.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Pending variant="outline">Refine toward actuals</Pending>
        {state.error ? (
          <p role="alert" className="text-sm text-status-critical">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** Copying a budget, items and all — how next Christmas starts from this one. */
function DuplicateButton({ budgetId }: { budgetId: string }) {
  const [, formAction] = useActionState<BudgetActionState, FormData>(duplicateBudget, NO_ERROR);
  return (
    <form action={formAction}>
      <input type="hidden" name="budgetId" value={budgetId} />
      <Pending variant="outline">Duplicate</Pending>
    </form>
  );
}

function DeleteButton({ budgetId, name }: { budgetId: string; name: string }) {
  const [, formAction] = useActionState<BudgetActionState, FormData>(deleteBudget, NO_ERROR);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-muted hover:text-status-critical"
        onClick={() => setConfirming(true)}
      >
        Delete budget
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="budgetId" value={budgetId} />
      <span className="text-sm">
        Delete “{name}” and all its items? This cannot be undone.
      </span>
      <Pending variant="destructive">Delete</Pending>
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        Keep it
      </Button>
    </form>
  );
}

/** A submit button that says what it is doing. Separate so `useFormStatus`
 *  reads the form it is rendered inside. */
function Pending({
  children,
  variant,
}: {
  children: React.ReactNode;
  variant: "outline" | "destructive";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {pending ? "Working…" : children}
    </Button>
  );
}
