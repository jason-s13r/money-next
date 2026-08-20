"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPeriodKey, periodKey, type TaxYear } from "@/lib/periods";
import { setTaxYearStart } from "./actions";

// Where the household's tax year starts, as a month and a day of it.
//
// A client component because the preview under the fields is the point: "1 April"
// is an abstraction and "FY27 (Apr 2026 – Mar 2027)" is the thing the reader
// actually wants to check, and it has to update as they change the fields rather
// than after a save. Both lines are computed with the very functions the
// breakdown buckets with, so the preview cannot promise a span the metrics
// don't use.

const MONTH_NAME = new Intl.DateTimeFormat("en-NZ", { month: "long", timeZone: "UTC" });

const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: MONTH_NAME.format(new Date(Date.UTC(2001, i, 1))),
}));

/** Matches the native select in members/invite-form.tsx, which has the same
 *  problem: there is no shadcn Select installed, so this is an `<Input>`-shaped
 *  `<select>`. */
const SELECT_CLASS =
  "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export function TaxYearForm({
  taxYear,
  dayMax,
  canEdit,
}: {
  taxYear: TaxYear;
  /** The largest day of the month a year may start on. See `isTaxYearStart`. */
  dayMax: number;
  canEdit: boolean;
}) {
  const [saved, setSaved] = useState(taxYear);
  const [startMonth, setStartMonth] = useState(taxYear.startMonth);
  const [startDay, setStartDay] = useState(String(taxYear.startDay));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const day = Number(startDay);
  const valid = Number.isInteger(day) && day >= 1 && day <= dayMax;

  // The tax year in progress under the *pending* choice, not the saved one, so
  // the reader sees what pressing Save would mean before they press it.
  const draft: TaxYear = { startMonth, startDay: valid ? day : saved.startDay };
  const preview = formatPeriodKey(periodKey(new Date(), "taxyear", draft), "taxyear", draft);

  const dirty = startMonth !== saved.startMonth || (valid && day !== saved.startDay);

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await setTaxYearStart(startMonth, day);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setSaved({ startMonth: result.startMonth, startDay: result.startDay });
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="mt-4 flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Month
          <select
            name="startMonth"
            value={startMonth}
            onChange={(e) => setStartMonth(Number(e.target.value))}
            disabled={!canEdit || pending}
            className={SELECT_CLASS}
          >
            {MONTHS.map((month) => (
              <option key={month.value} value={month.value}>
                {month.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Day
          <Input
            name="startDay"
            type="number"
            inputMode="numeric"
            min={1}
            max={dayMax}
            value={startDay}
            onChange={(e) => setStartDay(e.target.value)}
            disabled={!canEdit || pending}
            className="h-9 w-20"
          />
        </label>

        {canEdit ? (
          <Button type="submit" disabled={pending || !valid || !dirty}>
            {pending ? "Saving…" : "Save"}
          </Button>
        ) : null}
      </div>

      <p className="text-sm text-muted">
        The tax year in progress would be{" "}
        <span className="text-foreground">{preview}</span>.
      </p>

      {/* Said once, here, because it is the question the day field raises. */}
      <p className="text-xs text-muted">
        A tax year runs for a year, so its end follows from its start — there is
        nothing to set. Days after the {dayMax}th are not offered: they fall out of
        the calendar in some years.
      </p>

      {!valid ? (
        <p role="alert" className="text-sm text-status-critical">
          Pick a day from 1 to {dayMax}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-status-critical">
          {error}
        </p>
      ) : null}
    </form>
  );
}
