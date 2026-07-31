"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { createBudget, updateBudget } from "./actions";
import { NO_ERROR, type BudgetActionState } from "./types";

// Naming a budget and setting its lifespan — the same form for creating one and
// for editing one, because they ask exactly the same questions.
//
// The lifespan choice is the interesting control. It is a two-way radio rather
// than a pair of optional date fields, because "always on" is not "a window with
// the dates left blank" — it is the answer most budgets want, and burying it in
// two empty inputs makes the common case look unfinished.

export type BudgetFormValues = {
  id: string;
  name: string;
  startsOn: string | null;
  endsOn: string | null;
  repeatsAnnually: boolean;
  forecast: boolean;
};

/** `YYYY-MM-DD` for a date input, which is what the action parses back. */
export function dayValue(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

const SELECT_ROW = "flex flex-col gap-1 text-sm";

/**
 * The "when does it apply?" control: an always-on / windowed radio and, when
 * windowed, the date pair and the repeats toggle.
 *
 * Its own component because both a budget and a layer ask exactly this, and a
 * layer defaults to a window (a seasonal extra) where a base defaults to always
 * on. The lifespan choice is a two-way radio rather than a pair of optional date
 * fields, because "always on" is not "a window with the dates left blank" — it is
 * the answer most bases want, and burying it in two empty inputs makes the common
 * case look unfinished.
 */
export function LifespanFields({
  startsOn,
  endsOn,
  repeatsAnnually,
  defaultWindowed = false,
  windowHint,
}: {
  startsOn?: string | null;
  endsOn?: string | null;
  repeatsAnnually?: boolean;
  /** Which radio starts selected when there is no existing window to infer from. */
  defaultWindowed?: boolean;
  /** Overrides the "only between two dates" description, so a layer can say the
   *  extra applies only within its window. */
  windowHint?: string;
}) {
  const [windowed, setWindowed] = useState(Boolean(startsOn && endsOn) || defaultWindowed);
  const [repeats, setRepeats] = useState(repeatsAnnually ?? false);

  return (
    <>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm">When does it apply?</legend>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="lifespan"
            value="always"
            checked={!windowed}
            onChange={() => setWindowed(false)}
            className="mt-1"
          />
          <span>
            Always on
            <span className="block text-xs text-muted">
              Ordinary life — rent, groceries, the power bill.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="lifespan"
            value="window"
            checked={windowed}
            onChange={() => setWindowed(true)}
            className="mt-1"
          />
          <span>
            Only between two dates
            <span className="block text-xs text-muted">
              {windowHint ??
                "Christmas, a holiday, a course of treatment. Spending here is on top of your always-on budgets, not instead of them."}
            </span>
          </span>
        </label>
      </fieldset>

      {windowed ? (
        <div className="flex flex-col gap-3 rounded-lg border border-input p-3">
          <div className="flex flex-wrap gap-3">
            <label className={`${SELECT_ROW} flex-1`}>
              Starts
              <Input type="date" name="startsOn" defaultValue={startsOn ?? undefined} required />
            </label>
            <label className={`${SELECT_ROW} flex-1`}>
              Ends
              <Input type="date" name="endsOn" defaultValue={endsOn ?? undefined} required />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              name="repeatsAnnually"
              checked={repeats}
              onCheckedChange={(value) => setRepeats(value === true)}
            />
            Repeats every year
          </label>

          <p className="text-xs text-muted">
            {repeats
              ? // Worth saying plainly: this is the one case where an end date
                // earlier than the start is meaningful rather than a typo.
                "Only the day and month matter. A window may run across New Year — 15 December to 5 January works."
              : "A one-off window. Tick “repeats every year” for something like Christmas."}
          </p>
        </div>
      ) : null}
    </>
  );
}

export function BudgetForm({ budget }: { budget?: BudgetFormValues }) {
  const action = budget ? updateBudget : createBudget;
  const [state, formAction] = useActionState<BudgetActionState, FormData>(action, NO_ERROR);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {budget ? <input type="hidden" name="budgetId" value={budget.id} /> : null}

      <label className={SELECT_ROW}>
        Name
        <Input name="name" defaultValue={budget?.name} required autoComplete="off" />
      </label>

      <LifespanFields
        startsOn={budget?.startsOn}
        endsOn={budget?.endsOn}
        repeatsAnnually={budget?.repeatsAnnually}
      />

      <label className="flex items-start gap-2 text-sm">
        <Checkbox name="forecast" checked={budget?.forecast} className="mt-0.5" />
        <span>
          Use this budget as a forecast
          <span className="block text-xs text-muted">
            Projects it forward on the dashboard balance chart and runway tiles.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <Submit editing={Boolean(budget)} />
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
function Submit({ editing }: { editing: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : editing ? "Save changes" : "Create budget"}
    </Button>
  );
}
