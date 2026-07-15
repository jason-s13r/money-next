// Stat tile: label · value · optional note. No sparkline — `BalanceSnapshot`
// holds a single day, so there is no trend to draw yet and a flat line would be
// a lie rather than an absence.

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
    <div className="rounded-lg border border-current/10 p-4">
      <p className="text-sm text-secondary">{label}</p>
      {/* Proportional figures: tabular-nums makes a large standalone number look loose. */}
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {status && statusLabel ? (
        // Status never rides on colour alone — the dot is paired with a word.
        <p className="mt-1 flex items-center gap-1.5 text-xs text-secondary">
          <span className={`inline-block size-2 rounded-full ${STATUS_DOT[status]}`} />
          {statusLabel}
        </p>
      ) : null}
      {note ? <p className="mt-1 text-xs text-muted">{note}</p> : null}
    </div>
  );
}

export type HeroRunway = {
  /** Scenario name shown before the note. */
  label: string;
  /** Pre-built status text, e.g. "12.5 months · $3,400/mo". */
  note: string;
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
      <p className="mt-1 text-5xl font-semibold tracking-tight">{value}</p>
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
              <span className="text-muted">{r.note}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
