import { getLabelsWithCounts } from "@/lib/server/queries/lookups";
import { Link } from "@/ui/chrome/workspace-context";
import { Badge } from "@/components/ui/badge";
import { StatList } from "@/ui/primitives/stat-list";
import { slugify } from "@/lib/slug";
import { DEFAULT_CURRENCY, formatMoney } from "@/lib/format";
import { positiveAmountClass } from "@/lib/ui/amount";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

// The index of the workspace's labels (see `Label`) — every tag, how many
// transactions carry it, each a link to that tag's own listing. Labels are made
// by tagging a transaction (on its page, inline in a listing, or in bulk); there
// is no "create a label" form here, so an empty state points back to that.

export const metadata = { title: "Labels" };

export default async function LabelsPage() {
  const labels = await getLabelsWithCounts();
  const tagged = labels.reduce((sum, l) => sum + l.count, 0);

  return (
    <main className="mx-auto w-full max-w-5xl p-2">
      <h1 className="sr-only">Labels</h1>

      <StatList
        className="mt-4 mb-4"
        stats={[
          { label: "Labels", value: labels.length.toLocaleString("en-NZ") },
          { label: "Tagged transactions", value: tagged.toLocaleString("en-NZ") },
        ]}
      />

      {labels.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">
          No labels yet. Tag a transaction — on its page, inline in any listing, or
          by selecting several rows — to create one.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {labels.map((label) => (
            <li key={label.id}>
              <Link
                href={`/labels/${slugify(label.name)}`}
                className="flex items-center justify-between gap-3 py-3 hover:opacity-80"
              >
                {/* accent, not the secondary variant, whose bg/text don't pair
                    in this theme — see the chip in labels-cell.tsx. */}
                <Badge variant="secondary" className="bg-accent text-accent-foreground">
                  {label.name}
                </Badge>
                <span className="flex shrink-0 items-center gap-4">
                  <span
                    className={`w-28 text-right font-mono text-sm tabular-nums ${positiveAmountClass(label.net)}`}
                  >
                    {formatMoney(label.net, DEFAULT_CURRENCY)}
                  </span>
                  <span className="w-14 text-right text-sm tabular-nums text-muted">
                    {label.count.toLocaleString("en-NZ")}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
