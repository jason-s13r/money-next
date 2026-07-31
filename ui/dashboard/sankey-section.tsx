"use client";

import { useState } from "react";
import type { SankeyData } from "@/lib/sankey";
import { Card, CardContent } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SankeyDiagram } from "./sankey";

// Active segment matches the app-wide filled-pill selection (see balance-chart-legend).
const ACTIVE_SEGMENT = "aria-pressed:bg-primary aria-pressed:text-primary-foreground";

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
      <Card size="sm">
        <CardContent>
        {periods.length > 1 && (
          <div className="-mx-1 mb-3 overflow-x-auto px-1">
            <ToggleGroup
              value={[String(periodIndex)]}
              onValueChange={(value) => {
                if (value[0]) setPeriodIndex(Number(value[0]));
              }}
              variant="outline"
              spacing={0}
              aria-label="Period"
            >
              {periods.map((p, i) => (
                <ToggleGroupItem key={p.key} value={String(i)} className={ACTIVE_SEGMENT}>
                  {p.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}
        {current ? (
          <SankeyDiagram data={current.data} displayCurrency={displayCurrency} title={current.label} />
        ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
