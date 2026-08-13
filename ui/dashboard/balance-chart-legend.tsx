import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RANGES } from "./balance-chart.util";

/** A row in a legend item's explanatory popover. `emphasis` marks the headline
 *  figure — the net burn, or the single figure a scenario reduces to. `divider`
 *  opens a new group without claiming to be a total: the monthly arithmetic and
 *  how long the plan lasts are two subjects, not one column of figures. */
export type LegendPopoverRow = {
  label: string;
  value: string;
  emphasis?: boolean;
  divider?: boolean;
};

export type LegendItem = {
  color: string;
  dashed?: boolean;
  label: string;
  /** When present, the label becomes a hover/tap affordance revealing how the
   *  scenario's monthly figure is built — the same breakdown as the runway tile.
   *  `note` is a caveat about the figures, and only some scenarios have one. */
  popover?: { note: string | null; rows: LegendPopoverRow[] };
};

// The active segment keeps the app-wide filled-pill treatment rather than the toggle's
// default muted fill — on a near-white card muted-on-white barely reads, and every other
// filter row in the app marks its selection this way. `primary` rather than the
// `foreground`/`background` inversion it used to be: what is selected is the same kind
// of statement as the current nav item, and should be the same colour as it.
// tailwind-merge lets these win over the variant's defaults.
const ACTIVE_SEGMENT = "aria-pressed:bg-primary aria-pressed:text-primary-foreground";

export function BalanceChartLegend({
  legend,
  rangeKey,
  onRangeChange,
}: {
  legend: LegendItem[];
  /** The range the window currently matches, or null once it has been dragged
   *  off every preset — then no button claims to be the one being shown. */
  rangeKey: string | null;
  onRangeChange: (key: string) => void;
}) {
  return (
    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-secondary">
        {legend.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5">
            {l.dashed ? (
              <span className="inline-block h-0 w-4 shrink-0 border-t-2 border-dashed" style={{ borderColor: l.color }} />
            ) : (
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: l.color }} />
            )}
            {l.popover ? (
              // Popover, not Tooltip: opens on hover for pointer users and on tap
              // for touch users, where a hover-only tooltip never would.
              <Popover>
                <PopoverTrigger
                  openOnHover
                  render={
                    <span className="cursor-help underline decoration-dotted underline-offset-2">{l.label}</span>
                  }
                />
                <PopoverContent className="flex max-w-64 flex-col gap-2 text-left">
                  {l.popover.note ? <span className="text-secondary">{l.popover.note}</span> : null}
                  <span className="flex flex-col gap-1">
                    {l.popover.rows.map((row) => (
                      <span
                        key={row.label}
                        className={
                          row.emphasis
                            ? "flex justify-between gap-6 border-t border-border pt-1 font-medium text-foreground"
                            : row.divider
                              ? "mt-0.5 flex justify-between gap-6 border-t border-border pt-1 text-secondary"
                              : "flex justify-between gap-6 text-secondary"
                        }
                      >
                        <span>{row.label}</span>
                        <span className="tabular-nums">{row.value}</span>
                      </span>
                    ))}
                  </span>
                </PopoverContent>
              </Popover>
            ) : (
              l.label
            )}
          </span>
        ))}
      </figcaption>
      {/* Zoom — shortcuts that set the time window to a span centred on today.
          Resolution stays one day. A segmented ToggleGroup gives arrow-key
          navigation and 32px tap targets; on a phone the eight ranges overflow
          the row, so the track scrolls horizontally. */}
      <div className="-mx-1 overflow-x-auto px-1 sm:mx-0 sm:overflow-visible sm:px-0">
        <ToggleGroup
          value={rangeKey ? [rangeKey] : []}
          onValueChange={(value) => {
            if (value[0]) onRangeChange(value[0]);
          }}
          variant="outline"
          spacing={0}
          aria-label="Zoom range"
        >
          {RANGES.map((r) => (
            <ToggleGroupItem key={r.key} value={r.key} className={ACTIVE_SEGMENT}>
              {r.key}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </div>
  );
}
