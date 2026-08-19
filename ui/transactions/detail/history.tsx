import { Link } from "@/ui/chrome/workspace-context";
import type { HistoryEntry } from "@/lib/server/queries/history";
import { formatDateTime } from "@/lib/format";

// The transaction's field change log, newest first: who changed which enrichment
// field, from what to what, and when. Presentational — the page fetches.
//
// Renders nothing when there is no history, rather than an empty panel. Most
// transactions have none and always will: the log records changes from the day it
// shipped, and a transaction Akahu categorised once and nobody has touched since
// has no story to tell. An empty box on every page would be a worse answer than
// no box.

const FIELD_LABEL: Record<string, string> = {
  category: "Category",
  merchant: "Merchant",
  transfer: "Transfer",
  label: "Label",
};

/** The run behind an entry, when one made it. A `user` change has none. */
function runHref(entry: HistoryEntry) {
  if (entry.ruleRunId) return `/rules/runs/${entry.ruleRunId}`;
  if (entry.syncRunId) return `/sync/${entry.syncRunId}`;
  return null;
}

/**
 * Who made the change, in the reader's terms.
 *
 * `By hand` rather than a name — or a guessed "You" — while `actorUserId` is
 * null on every row: before phase 3 this instance had no idea who anyone was, and
 * saying so is better than implying it was the reader. Once auth ships the rows
 * carry a real person and this shows their name.
 */
function sourceLabel(entry: HistoryEntry) {
  if (entry.source === "akahu") return "Akahu";
  if (entry.source === "rule") return "Rule";
  return entry.actorName ?? "By hand";
}

function Change({ entry }: { entry: HistoryEntry }) {
  if (entry.field === "transfer") {
    return entry.toLabel ? (
      <span className="text-muted">
        linked to <span className="text-foreground">{entry.toLabel}</span>
      </span>
    ) : (
      <span className="text-muted">
        unlinked{entry.fromLabel ? <> from <span className="text-foreground">{entry.fromLabel}</span></> : null}
      </span>
    );
  }

  return (
    <span>
      {entry.fromLabel ? (
        <>
          <span className="text-muted line-through">{entry.fromLabel}</span>{" "}
          <span className="opacity-40">→</span>{" "}
        </>
      ) : null}
      {entry.toLabel ? (
        <span className="font-medium">{entry.toLabel}</span>
      ) : (
        // A cleared field. The em dash is the same "nothing here" the read-only
        // fields above use, so it reads as a value rather than as missing data.
        <span className="opacity-40">—</span>
      )}
    </span>
  );
}

export function TransactionHistory({ entries }: { entries: HistoryEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 border-b border-current/20 pb-2 text-sm font-medium opacity-60">
        History
      </h2>
      <ol className="flex flex-col gap-3 text-sm">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="rounded bg-current/10 px-1.5 py-0.5 text-xs">
              {FIELD_LABEL[entry.field] ?? entry.field}
            </span>
            <Change entry={entry} />
            <span className="ml-auto whitespace-nowrap text-xs text-muted">
              {runHref(entry) ? (
                <Link
                  href={runHref(entry)!}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {sourceLabel(entry)}
                </Link>
              ) : (
                sourceLabel(entry)
              )}
              {" · "}
              {formatDateTime(entry.createdAt)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
