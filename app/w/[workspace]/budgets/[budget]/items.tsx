"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatMoney } from "@/lib/format";
import { isIncomeGroup } from "@/lib/categories";
import { useCanEdit } from "@/ui/chrome/workspace-context";
import { DeleteItemButton, ItemForm, type ItemFormValues } from "./item-form";

// A budget's items, grouped under their category group.
//
// The group subtotal is the sum of its items and nothing else: there is no
// separate group target, so there is no second number here that could disagree
// with the first. That is the whole reason the model has no group-level amount.
//
// A client island because each row opens an editor in place. Everything it needs
// is handed down from the server page — the catalogs are small (a few hundred
// categories) and shipping them once beats a round trip per row opened.

export type ItemRow = ItemFormValues & {
  currency: string;
  cadence: string;
  groupName: string;
  categoryName: string | null;
  merchantName: string | null;
  inferred: boolean;
  /** How a still-guessed row was produced: `ai` | `computed` | null. */
  inferredSource: string | null;
  /** The seeder's rationale, shown in the provenance badge's popover. */
  basis: string | null;
};

type Option = { id: string; name: string };
type CategoryOption = Option & { groupId: string | null; groupName: string | null };

export function BudgetItems({
  budgetId,
  items,
  groups,
  categories,
  merchants,
}: {
  budgetId: string;
  items: ItemRow[];
  groups: Option[];
  categories: CategoryOption[];
  merchants: Option[];
}) {
  // An inferred budget is editable in place like any other; the "Guessed" badge
  // marks the rows still resting on a guess, and editing one clears it.
  const canEdit = useCanEdit();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const catalogs = { groups, categories, merchants };

  // Grouped in place rather than by a second query: the items are already here,
  // and a group with no items has nothing to show anyway.
  const byGroup = new Map<string, ItemRow[]>();
  for (const item of items) {
    const list = byGroup.get(item.groupName) ?? [];
    list.push(item);
    byGroup.set(item.groupName, list);
  }
  // Income groups first, then spending groups, each alphabetical: what comes in is
  // read before what goes out, the same order a budget is reasoned about in.
  const groupNames = [...byGroup.keys()].toSorted((a, b) => {
    const rank = Number(isIncomeGroup(a)) - Number(isIncomeGroup(b));
    return rank !== 0 ? -rank : a.localeCompare(b, "en-NZ");
  });

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Items</h2>
        {canEdit && !adding ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            Add item
          </Button>
        ) : null}
      </div>

      {adding ? (
        <div className="mb-4 rounded-lg border border-input p-3">
          <ItemForm budgetId={budgetId} {...catalogs} onDone={() => setAdding(false)} />
        </div>
      ) : null}

      {items.length === 0 && !adding ? (
        <p className="py-8 text-center text-sm opacity-60">
          Nothing budgeted yet. Add an item — an amount, how often it happens, and the
          category group it comes out of.
        </p>
      ) : null}

      {groupNames.map((groupName) => {
        const rows = byGroup.get(groupName)!;
        const subtotal = rows.reduce((sum, row) => sum + row.amount, 0);

        return (
          <div key={groupName} className="mb-5">
            <div className="flex items-baseline justify-between border-b border-current/20 pb-1">
              <h3 className="text-sm">{groupName}</h3>
              <span className="font-mono text-sm tabular-nums">
                {formatMoney(subtotal, null)}
              </span>
            </div>

            <ul className="flex flex-col divide-y divide-border">
              {rows.map((item) => (
                <li key={item.id} className="py-2">
                  {editing === item.id ? (
                    <div className="rounded-lg border border-input p-3">
                      <ItemForm
                        budgetId={budgetId}
                        item={item}
                        {...catalogs}
                        onDone={() => setEditing(null)}
                      />
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex items-center gap-2">
                          <span className="truncate">{item.name}</span>
                          {/* Whose figure this is, for as long as it is still theirs.
                              A seeded guess, or one a model proposed in chat — which
                              is not a guess (nothing may overwrite it) but is still
                              the model's, and worth saying so beside. It goes when
                              somebody retypes the amount by hand, because
                              `updateBudgetItem` clears the provenance with it. */}
                          {item.inferred || item.inferredSource ? (
                            <ProvenanceBadge source={item.inferredSource} basis={item.basis} />
                          ) : null}
                        </span>
                        <span className="text-xs text-muted">
                          {item.cadence}
                          {item.categoryName ? ` · ${item.categoryName}` : ""}
                          {item.merchantName ? ` · ${item.merchantName}` : ""}
                        </span>
                      </span>

                      <span className="flex shrink-0 items-center gap-1">
                        <span className="font-mono text-sm tabular-nums">
                          {formatMoney(item.amount, null)}
                        </span>
                        {canEdit ? (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => setEditing(item.id)}>
                              Edit
                            </Button>
                            <DeleteItemButton itemId={item.id} />
                          </>
                        ) : null}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/**
 * The badge on an item nobody has retyped: what produced its figure, and — in a
 * popover — the reason given for it.
 *
 * "AI" for a row the local model named, "Computed" for one the deterministic
 * detector found (including where the model failed for a group and the detector
 * stood in). The `outline` variant, not `secondary`: the secondary token washes out
 * against the row and read as unlabelled. When there is a `basis` the badge is a
 * popover trigger — a plain span otherwise, so it never offers a click with nothing
 * behind it.
 */
function ProvenanceBadge({ source, basis }: { source: string | null; basis: string | null }) {
  // A row seeded before provenance was recorded has neither; say the honest minimum.
  const label = source === "ai" ? "AI" : source === "computed" ? "Computed" : "Guessed";

  if (!basis) {
    return <Badge variant="outline">{label}</Badge>;
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Badge variant="outline" className="cursor-pointer">
            {label}
          </Badge>
        }
      />
      <PopoverContent side="top" align="start">
        <p className="font-medium">
          {source === "ai" ? "Inferred by AI" : "Computed from history"}
        </p>
        <p className="mt-1 text-muted-foreground">{basis}</p>
      </PopoverContent>
    </Popover>
  );
}
