"use client";

import { useState } from "react";
import type { SankeyData } from "@/lib/sankey";
import { SankeyDiagram } from "./sankey";

/**
 * One period's diagram, already built. The adapter reads a whole Comparison —
 * every merchant, every subcategory, every period's detail — to yield the few
 * dozen nodes drawn here, so it runs on the server and only its result crosses.
 * All this component owns is which period is on screen.
 */
export type SankeyPeriod = { key: string; label: string; data: SankeyData };

export function SankeySection({
  periods,
  displayCurrency,
}: {
  periods: SankeyPeriod[];
  displayCurrency: string;
}) {
  // Default to the last (most recent/current) period that has data.
  const [periodIndex, setPeriodIndex] = useState(() => Math.max(0, periods.length - 1));

  const current = periods[periodIndex];

  return (
    <section>
      <div className="rounded-lg border border-current/10 p-3">
        {periods.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-1 text-sm">
            {periods.map((p, i) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPeriodIndex(i)}
                className={`rounded-md px-2.5 py-1 ${
                  i === periodIndex ? "bg-foreground text-background" : "text-secondary hover:bg-current/5"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        {current ? (
          <SankeyDiagram data={current.data} displayCurrency={displayCurrency} title={current.label} />
        ) : null}
      </div>
    </section>
  );
}
