// Stat tile: label · value · optional note. No sparkline — `BalanceSnapshot`
// holds a single day, so there is no trend to draw yet and a flat line would be
// a lie rather than an absence. The surface is a shadcn Card so every tile,
// panel and period card across the app shares one card treatment.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type Status = "good" | "warning" | "critical";

const STATUS_DOT: Record<Status, string> = {
  good: "bg-status-good",
  warning: "bg-status-warning",
  critical: "bg-status-critical",
};

export function StatTile({
  label,
  value,
  note,
  status,
  statusLabel,
}: {
  label: string;
  value: string;
  note?: string;
  status?: Status;
  statusLabel?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        {/* Proportional figures: tabular-nums makes a large standalone number look loose. */}
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      {(status && statusLabel) || note ? (
        <CardContent className="flex flex-col gap-1">
          {status && statusLabel ? (
            // Status never rides on colour alone — the dot is paired with a word.
            <p className="flex items-center gap-1.5 text-xs text-secondary">
              <span className={`inline-block size-2 rounded-full ${STATUS_DOT[status]}`} />
              {statusLabel}
            </p>
          ) : null}
          {note ? <p className="text-xs text-muted">{note}</p> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

export type HeroRunway = {
  /** Scenario name shown before the note. */
  label: string;
  /** Pre-built runway phrase, e.g. "12.5 months runway". */
  runwayText: string;
  /** What the credit facility does after that, e.g. "Credit gone by 14 Nov
   *  2027". Null when there is none to draw on. */
  creditText?: string | null;
  /** The runway split into its phases — months on the balance, then months on
   *  credit — for the popover. Empty when the plan never depletes. */
  phases?: { label: string; value: string }[];
  /** Pre-built burn phrase, e.g. "burning $3,400/mo" or "$820/mo to spare". */
  burnText: string;
  /** Planned income and expenses that net to the burn, for the tooltip. */
  burnBreakdown: { expenses: string; income: string; net: string } | null;
  /** CSS colour token for the pulsing dot — must match the chart line. */
  color: string;
};

/** The single number the dashboard leads with. Exactly one per view. */
export function Hero({
  label,
  value,
  note,
  runways,
}: {
  label: string;
  value: string;
  note: string;
  runways?: HeroRunway[];
}) {
  return (
    <div>
      <p className="text-sm text-secondary">{label}</p>
      <p className="mt-1 text-4xl font-semibold tracking-tight sm:text-5xl">{value}</p>
      <p className="mt-2 text-sm text-muted">{note}</p>
      {runways && runways.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {runways.map((r) => (
            <p key={r.label} className="flex items-center gap-1.5 text-sm text-secondary">
              <span
                className="inline-block size-2 rounded-full animate-pulse"
                style={{ backgroundColor: r.color }}
              />
              <span className="font-medium">{r.label}</span>
              <span className="text-muted">
                {r.runwayText},{" "}
                {r.burnBreakdown || r.creditText ? (
                  // Popover, not Tooltip: opens on hover for pointer users and on
                  // tap for touch users, where a hover-only tooltip never would.
                  <Popover>
                    <PopoverTrigger
                      openOnHover
                      render={
                        <span className="cursor-help underline decoration-dotted underline-offset-2">
                          {r.burnText}
                        </span>
                      }
                    />
                    {/* Spell out the arithmetic: the net burn is planned expenses
                        less the periodic income planned to keep covering part of it. */}
                    <PopoverContent className="flex flex-col gap-1 text-left text-secondary">
                      {r.burnBreakdown ? (
                        <>
                          <span className="flex justify-between gap-6">
                            <span>Planned expenses</span>
                            <span className="tabular-nums">{r.burnBreakdown.expenses}</span>
                          </span>
                          <span className="flex justify-between gap-6">
                            <span>Less planned income</span>
                            <span className="tabular-nums">−{r.burnBreakdown.income}</span>
                          </span>
                          <span className="mt-0.5 flex justify-between gap-6 border-t border-border pt-1 font-medium text-foreground">
                            <span>Net</span>
                            <span className="tabular-nums">{r.burnBreakdown.net}</span>
                          </span>
                        </>
                      ) : null}
                      {/* How long it lasts, in the two phases that must not be
                          added together: months on the balance, then months on
                          credit. In here rather than on the face of the tile,
                          because the months figure out there deliberately counts
                          only the first of them — a reader who wants the borrowed
                          time is the one who opened the breakdown. */}
                      {r.phases?.length || r.creditText ? (
                        <span
                          className={
                            r.burnBreakdown
                              ? "mt-0.5 flex flex-col gap-1 border-t border-border pt-1"
                              : "flex flex-col gap-1"
                          }
                        >
                          {r.phases?.map((phase) => (
                            <span key={phase.label} className="flex justify-between gap-6">
                              <span>{phase.label}</span>
                              <span className="tabular-nums">{phase.value}</span>
                            </span>
                          ))}
                          {r.creditText ? (
                            <span className="whitespace-nowrap text-muted">{r.creditText}</span>
                          ) : null}
                        </span>
                      ) : null}
                    </PopoverContent>
                  </Popover>
                ) : (
                  r.burnText
                )}
              </span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
