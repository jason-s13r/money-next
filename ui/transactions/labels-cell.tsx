"use client";

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Link, useCanEdit } from "@/ui/chrome/workspace-context";
import { SearchableSelect } from "@/ui/primitives/searchable-select";
import { slugify } from "@/lib/slug";
import {
  addTransactionLabel,
  createLabelAndAddToTransaction,
  listLabels,
  removeTransactionLabel,
} from "@/app/w/[workspace]/transactions/[transactionId]/actions/label";

// A transaction's tags, rendered as chips and editable in place — the same
// component on a listing row and on the detail page. Read-only for a viewer (just
// the chips); for an editor each chip carries an `×` to remove it and a trailing
// picker adds one (or creates a new tag).
//
// The picker's option set is the workspace's whole label catalog, which is small
// and shared by every row, so it is fetched once through a context provider rather
// than per row. `LabelCatalogProvider` seeds it from the server on the detail page
// and lazy-loads it for a listing (only when the reader can edit).

export type LabelRef = { id: string; name: string };

type Catalog = { options: LabelRef[]; reload: () => Promise<void> };

const LabelCatalogContext = createContext<Catalog | null>(null);

export function LabelCatalogProvider({
  initial,
  children,
}: {
  /** Server-provided catalog (detail page); omitted on a listing, which lazy-loads. */
  initial?: LabelRef[];
  children: React.ReactNode;
}) {
  const canEdit = useCanEdit();
  const [options, setOptions] = useState<LabelRef[]>(initial ?? []);

  const reload = useCallback(async () => {
    setOptions(await listLabels());
  }, []);

  // Fetch the catalog once when the reader can edit and we weren't seeded with it.
  // The set happens in the async callback, not synchronously in the effect body.
  useEffect(() => {
    if (!canEdit || initial !== undefined) return;
    let live = true;
    void listLabels().then((opts) => {
      if (live) setOptions(opts);
    });
    return () => {
      live = false;
    };
  }, [canEdit, initial]);

  return <LabelCatalogContext value={{ options, reload }}>{children}</LabelCatalogContext>;
}

export function LabelsCell({
  transactionId,
  labels,
  linkLabels = true,
}: {
  transactionId: string;
  /** The row's current tags. */
  labels: LabelRef[];
  /** Render each chip as a link to its label page; off on a label's own page. */
  linkLabels?: boolean;
}) {
  const canEdit = useCanEdit();
  const router = useRouter();
  const catalog = use(LabelCatalogContext);
  const [pending, startTransition] = useTransition();

  const chips = labels.map((l) => (
    // `accent` rather than the `secondary` variant: this theme remaps
    // `--color-secondary` to a dark text colour, so `bg-secondary` pairs a dark
    // pill with near-black text (unreadable). The accent tokens are correctly
    // paired (light pill/dark text, inverted in dark mode).
    <Badge
      key={l.id}
      variant="secondary"
      className="gap-1 bg-accent text-accent-foreground"
    >
      {linkLabels ? (
        <Link href={`/labels/${slugify(l.name)}`} className="hover:underline">
          {l.name}
        </Link>
      ) : (
        l.name
      )}
      {canEdit ? (
        <button
          type="button"
          aria-label={`Remove label ${l.name}`}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await removeTransactionLabel(transactionId, l.id);
              router.refresh();
            })
          }
          className="-mr-0.5 rounded-full px-0.5 leading-none opacity-60 hover:opacity-100 disabled:opacity-40"
        >
          ×
        </button>
      ) : null}
    </Badge>
  ));

  if (!canEdit) {
    return labels.length > 0 ? (
      <div className="flex flex-wrap gap-1">{chips}</div>
    ) : (
      <span className="text-muted">—</span>
    );
  }

  // Only labels the row doesn't already carry are worth offering.
  const options = (catalog?.options ?? [])
    .filter((o) => !labels.some((l) => l.id === o.id))
    .map((o) => ({ value: o.id, label: o.name }));

  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips}
      {/* Keyed on the current tag set so it remounts fresh after each add,
          resetting to the "add" placeholder rather than showing the tag just
          chosen as if it were a persistent value. */}
      <SearchableSelect
        key={labels.map((l) => l.id).join(",")}
        ariaLabel="Add label"
        options={options}
        value={null}
        valueLabel={null}
        placeholder="+ Label"
        onSelect={async (id) => {
          if (!id) return;
          await addTransactionLabel(transactionId, id);
          router.refresh();
        }}
        onCreate={async (name) => {
          await createLabelAndAddToTransaction(transactionId, name);
          await catalog?.reload();
          router.refresh();
        }}
        createLabel="Create label “%s”"
      />
    </div>
  );
}
