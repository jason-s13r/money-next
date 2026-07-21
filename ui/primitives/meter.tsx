// Charts are plain HTML marks, not SVG: they stay responsive without measuring,
// and there is one series in each, so no categorical palette is in play. Mark
// specs follow the house data-viz rules — text in ink tokens rather than the
// series colour, hairline recessive tracks. The bar is ours; the surface is a
// shadcn Card so it matches every other panel.

import { Card, CardContent, CardHeader, CardDescription } from "@/components/ui/card";

/**
 * A single ratio against a limit. The unfilled track is a lighter step of the
 * same hue, so the state reads across the whole bar rather than only the fill.
 */
export function Meter({
  label,
  fraction,
  caption,
}: {
  label: string;
  fraction: number;
  caption: string;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-baseline justify-between">
          <CardDescription>{label}</CardDescription>
          <p className="font-mono text-sm tabular-nums">{(fraction * 100).toFixed(0)}%</p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="h-2 w-full overflow-hidden rounded-full bg-viz-track">
          <div
            className="h-full rounded-full bg-viz-series"
            style={{ width: `${Math.min(100, fraction * 100)}%` }}
          />
        </div>
        <p className="text-xs text-muted">{caption}</p>
      </CardContent>
    </Card>
  );
}
