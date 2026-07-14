// A row of label/value figures — the summary header shared by the transaction
// listings (via `Listing`), the account page, and search. Monospace tabular
// values so columns of figures line up.

export function StatList({
  stats,
  className = "",
}: {
  stats: { label: string; value: string }[];
  className?: string;
}) {
  return (
    <dl className={`flex flex-wrap gap-x-10 gap-y-3 text-sm ${className}`}>
      {stats.map((stat) => (
        <div key={stat.label}>
          <dt className="opacity-60">{stat.label}</dt>
          <dd className="font-mono tabular-nums">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}
