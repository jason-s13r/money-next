// A rule's outputs, rendered as labelled pills — `Category: Social welfare`,
// `Merchant: Inland Revenue` — so it's clear *which* field each value sets, not
// just the value. Shared by the /rules list and the transaction "Automation"
// panel so both read the same. A rule with no outputs shows a muted note.

function OutputPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded bg-current/10 px-1.5 py-0.5 text-xs">
      <span className="opacity-50">{label}:</span> <span className="font-medium">{value}</span>
    </span>
  );
}

export function RuleOutputs({
  categoryName,
  merchantName,
  labelName = null,
}: {
  categoryName: string | null;
  merchantName: string | null;
  /** The tag the rule applies by name; absent means the derived one. */
  labelName?: string | null;
}) {
  if (!categoryName && !merchantName && !labelName) {
    return <span className="text-xs text-muted">no output set</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {categoryName ? <OutputPill label="Category" value={categoryName} /> : null}
      {merchantName ? <OutputPill label="Merchant" value={merchantName} /> : null}
      {labelName ? <OutputPill label="Label" value={labelName} /> : null}
    </span>
  );
}
