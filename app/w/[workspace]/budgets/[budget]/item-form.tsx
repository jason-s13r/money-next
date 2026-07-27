"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FREQUENCIES, FREQUENCY_LABELS, type Frequency } from "@/lib/budget/recurrence";
import { createBudgetItem, updateBudgetItem, deleteBudgetItem } from "../actions";
import { NO_ERROR, type BudgetActionState } from "../types";

// One intended transaction: how much, how often, and where it is filed.
//
// Two things here are less obvious than they look.
//
// **Nobody types a minus sign.** The direction is a toggle and the amount is a
// positive number; the action applies the sign. The stored column is signed like
// `Transaction.amount`, so the breakdown can tell income from spending the same
// way it does for real rows — but that is the database's business, not the
// typist's.
//
// **Fortnightly is a preset, not a frequency.** It is `week` × 2 in the data (see
// lib/budget/recurrence.ts), and offering it as a seventh frequency would make
// one cadence expressible two ways. Here it is a button that sets both fields,
// which is where a convenience like that belongs.

export type ItemFormValues = {
  id: string;
  name: string;
  amount: number;
  frequency: Frequency;
  interval: number;
  anchorDate: string;
  groupId: string;
  categoryId: string | null;
  merchantId: string | null;
};

type Option = { id: string; name: string };
type CategoryOption = Option & { groupName: string | null };

const FIELD = "flex flex-col gap-1 text-sm";
// Native select, styled to match `Input` beside it — no shadcn Select is
// installed, and the members invite form already sets this precedent.
const SELECT =
  "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/** Today as `YYYY-MM-DD`, the default anchor for a new item. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ItemForm({
  budgetId,
  item,
  groups,
  categories,
  merchants,
  onDone,
}: {
  budgetId: string;
  item?: ItemFormValues;
  groups: Option[];
  categories: CategoryOption[];
  merchants: Option[];
  onDone?: () => void;
}) {
  const editing = Boolean(item);
  const [state, formAction] = useActionState<BudgetActionState, FormData>(
    editing ? updateBudgetItem : createBudgetItem,
    NO_ERROR,
  );

  const [frequency, setFrequency] = useState<Frequency>(item?.frequency ?? "month");
  const [interval, setInterval] = useState(item?.interval ?? 1);
  const [direction, setDirection] = useState(
    item && item.amount > 0 ? "income" : "expense",
  );

  const fortnightly = frequency === "week" && interval === 2;

  return (
    <form
      action={async (formData) => {
        await formAction(formData);
        onDone?.();
      }}
      className="flex flex-col gap-3"
    >
      {editing ? (
        <input type="hidden" name="itemId" value={item!.id} />
      ) : (
        <input type="hidden" name="budgetId" value={budgetId} />
      )}
      <input type="hidden" name="frequency" value={frequency} />
      <input type="hidden" name="interval" value={interval} />
      <input type="hidden" name="direction" value={direction} />

      <div className="flex flex-wrap gap-3">
        <label className={`${FIELD} flex-1 min-w-40`}>
          What is it?
          <Input name="name" defaultValue={item?.name} placeholder="Power bill" required autoComplete="off" />
        </label>

        <label className={FIELD}>
          Amount
          <Input
            name="amount"
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            defaultValue={item ? Math.abs(item.amount) : undefined}
            required
          />
        </label>

        <div className={FIELD}>
          Direction
          {/* Base UI's ToggleGroup is array-valued (see the balance chart's zoom
              row); a single-choice group is a one-element array whose empty case
              is ignored, so the direction can never be unset by a stray click. */}
          <ToggleGroup
            value={[direction]}
            onValueChange={(value) => value[0] && setDirection(value[0])}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="expense">Money out</ToggleGroupItem>
            <ToggleGroupItem value="income">Money in</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className={FIELD}>
          How often
          <select
            className={SELECT}
            value={fortnightly ? "fortnight" : frequency}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "fortnight") {
                setFrequency("week");
                setInterval(2);
                return;
              }
              setFrequency(value as Frequency);
              setInterval(1);
            }}
          >
            {FREQUENCIES.map((option) => (
              <option key={option} value={option}>
                {FREQUENCY_LABELS[option]}
              </option>
            ))}
            {/* Stored as week × 2; offered here because it is what people say. */}
            <option value="fortnight">Fortnightly</option>
          </select>
        </label>

        <label className={FIELD}>
          {frequency === "once" ? "On" : "Starting from"}
          <Input type="date" name="anchorDate" defaultValue={item?.anchorDate ?? today()} required />
        </label>

        {frequency !== "once" && !fortnightly ? (
          <label className={FIELD}>
            Every
            <span className="flex items-center gap-2">
              <Input
                type="number"
                min="1"
                max="365"
                value={interval}
                onChange={(event) => setInterval(Math.max(1, Number(event.target.value) || 1))}
                className="w-20"
              />
              <span className="text-sm text-muted">
                {interval === 1 ? frequency : `${frequency}s`}
              </span>
            </span>
          </label>
        ) : null}
      </div>

      <p className="text-xs text-muted">
        {frequency === "once"
          ? "A one-off — it happens on that date and never again."
          : "The date sets the day within the period: the 1st of the month, or which weekday. It also fixes which fortnight, if you repeat every 2 weeks."}
      </p>

      <div className="flex flex-wrap gap-3">
        <label className={`${FIELD} flex-1 min-w-40`}>
          Category group
          <select name="categoryGroupId" defaultValue={item?.groupId ?? ""} required className={SELECT}>
            <option value="" disabled>
              Choose a group…
            </option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>

        <label className={`${FIELD} flex-1 min-w-40`}>
          Category <span className="text-muted">(optional)</span>
          <select name="categoryId" defaultValue={item?.categoryId ?? ""} className={SELECT}>
            <option value="">Any</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
                {category.groupName ? ` · ${category.groupName}` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className={`${FIELD} flex-1 min-w-40`}>
          Merchant <span className="text-muted">(optional)</span>
          <select name="merchantId" defaultValue={item?.merchantId ?? ""} className={SELECT}>
            <option value="">Any</option>
            {merchants.map((merchant) => (
              <option key={merchant.id} value={merchant.id}>
                {merchant.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <Submit editing={editing} />
        {onDone ? (
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
        {state.error ? (
          <p role="alert" className="text-sm text-status-critical">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function Submit({ editing }: { editing: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Saving…" : editing ? "Save item" : "Add item"}
    </Button>
  );
}

/** Removing an item. Its own form so the delete POSTs on its own. */
export function DeleteItemButton({ itemId }: { itemId: string }) {
  const [, formAction] = useActionState<BudgetActionState, FormData>(deleteBudgetItem, NO_ERROR);
  return (
    <form action={formAction}>
      <input type="hidden" name="itemId" value={itemId} />
      <Button type="submit" variant="ghost" size="sm" className="text-muted hover:text-status-critical">
        Remove
      </Button>
    </form>
  );
}
