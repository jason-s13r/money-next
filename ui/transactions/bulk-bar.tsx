"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useRelativePath } from "@/ui/chrome/workspace-context";
import { SearchableSelect } from "@/ui/primitives/searchable-select";
import {
  bulkAddLabel,
  bulkLinkTransfer,
  bulkRemoveLabel,
  bulkSetCategory,
  bulkSetMerchant,
  createLabelForBulk,
  loadPickerCatalog,
} from "@/app/w/[workspace]/transactions/actions/bulk";

// The action bar that appears once one or more rows are ticked in a transaction
// listing. Each control is the same combobox the detail page uses, but pointed at
// the whole selection: pick a label to add or remove, a merchant, or a category,
// and it applies to every selected row at once and then clears the selection.
// Link transfers is the exception — a plain button, because grouping the ticked
// rows into one transfer needs no option set, only the selection itself.
//
// The option sets (labels/merchants/categories) are loaded once when the bar first
// appears — there is no point shipping them with every page when most readers never
// bulk-edit. `path` is the current listing, which the actions revalidate.

type Catalog = Awaited<ReturnType<typeof loadPickerCatalog>>;

export function TransactionBulkBar({ ids, clear }: { ids: string[]; clear: () => void }) {
  const path = useRelativePath();
  const router = useRouter();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [linking, startLinking] = useTransition();

  useEffect(() => {
    let live = true;
    void loadPickerCatalog().then((c) => {
      if (live) setCatalog(c);
    });
    return () => {
      live = false;
    };
  }, []);

  // After any bulk write: refresh the list to show the change, then drop the
  // selection so the bar folds away.
  function done() {
    router.refresh();
    clear();
  }

  const labelOptions = (catalog?.labels ?? []).map((l) => ({ value: l.id, label: l.name }));
  const merchantOptions = (catalog?.merchants ?? []).map((m) => ({ value: m.id, label: m.name }));
  const categoryOptions = (catalog?.categories ?? []).map((c) => ({
    value: c.id,
    label: c.name,
    hint: c.groupName ?? undefined,
  }));

  return (
    <div className="sticky bottom-2 z-20 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/95 p-2 shadow-lg backdrop-blur">
      <span className="px-1 text-sm font-medium tabular-nums">
        {ids.length} selected
      </span>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <SearchableSelect
          ariaLabel="Add label to selected"
          options={labelOptions}
          value={null}
          valueLabel={null}
          placeholder="Add label…"
          onSelect={async (id) => {
            if (!id) return;
            await bulkAddLabel(ids, id, path);
            done();
          }}
          onCreate={async (name) => {
            const label = await createLabelForBulk(name);
            await bulkAddLabel(ids, label.id, path);
            done();
          }}
          createLabel="Create label “%s”"
        />

        <SearchableSelect
          ariaLabel="Remove label from selected"
          options={labelOptions}
          value={null}
          valueLabel={null}
          placeholder="Remove label…"
          onSelect={async (id) => {
            if (!id) return;
            await bulkRemoveLabel(ids, id, path);
            done();
          }}
        />

        <SearchableSelect
          ariaLabel="Set merchant on selected"
          options={merchantOptions}
          value={null}
          valueLabel={null}
          placeholder="Set merchant…"
          clearLabel="No merchant"
          onSelect={async (id) => {
            await bulkSetMerchant(ids, id, path);
            done();
          }}
        />

        <SearchableSelect
          ariaLabel="Set category on selected"
          options={categoryOptions}
          value={null}
          valueLabel={null}
          placeholder="Set category…"
          clearLabel="Uncategorised"
          onSelect={async (id) => {
            await bulkSetCategory(ids, id, path);
            done();
          }}
        />

        {/* One leg is not a transfer, so this needs two rows before it means
            anything; it stays visible but disabled below that, rather than
            appearing and disappearing as the reader ticks. */}
        <Button
          variant="outline"
          size="sm"
          disabled={ids.length < 2 || linking}
          title={
            ids.length < 2
              ? "Select two or more transactions to link as one transfer"
              : undefined
          }
          onClick={() =>
            startLinking(async () => {
              await bulkLinkTransfer(ids, path);
              done();
            })
          }
        >
          Link transfers
        </Button>
      </div>

      <Button variant="ghost" size="sm" className="ml-auto" onClick={clear}>
        Clear
      </Button>
    </div>
  );
}
