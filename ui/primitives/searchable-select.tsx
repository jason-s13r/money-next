"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";

export type SelectOption = {
  value: string;
  label: string;
  /** Secondary text shown dimmed beside the label, e.g. a category's group. */
  hint?: string;
};

/**
 * A single-select combobox: a button showing the current value that opens a
 * filterable list. Built from a plain <input> and <ul> rather than a library —
 * the app carries no headless-ui dependency, and one accessible listbox is
 * cheaper than one.
 *
 * The full option set is handed over from the server and filtered on the client.
 * At this app's scale (a few hundred categories, similar order of merchants) that
 * is a trivial payload and instant to type against; a server-round-trip typeahead
 * would be more machinery for no felt benefit.
 *
 * Selection fires `onSelect` inside a transition so the row can show a pending
 * state while the server action runs. The chosen label is held locally so the
 * value updates immediately, before the surrounding page revalidates.
 */
export function SearchableSelect({
  options,
  value,
  valueLabel,
  onSelect,
  onCreate,
  createLabel,
  placeholder = "Set…",
  clearLabel,
  ariaLabel,
  readOnly = false,
}: {
  options: SelectOption[];
  value: string | null;
  /** The current value's display text — the denormalised name already on the row. */
  valueLabel: string | null;
  onSelect: (value: string | null) => Promise<void>;
  /** When present, a non-empty search with no matches shows a row that creates a new option. */
  onCreate?: (query: string) => Promise<void>;
  /** Label for the create row. Use `%s` as a placeholder for the query. */
  createLabel?: string;
  placeholder?: string;
  /** When present, an entry that unsets the value (e.g. "Uncategorised"). */
  clearLabel?: string;
  ariaLabel: string;
  /**
   * Render the current value as text, with no control at all.
   *
   * For a `viewer`, whose role cannot enrich (see lib/server/auth/roles.ts). The
   * caller decides rather than this component asking, so the primitive stays a
   * primitive and does not need a workspace to render — but the reason is worth
   * knowing: a combobox that opens, filters and then throws on select is a worse
   * answer than a label, and it was the app's real behaviour for every viewer
   * until phase 4 gave the instance its first one.
   *
   * Not `disabled`: a greyed-out control still says "this is yours, but not
   * now", which is the wrong sentence. The value is not pending or unavailable —
   * it is simply not theirs to set, and text says that without being asked.
   */
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pending, startTransition] = useTransition();
  // Show the just-chosen label immediately; falls back to the server's value.
  const [optimistic, setOptimistic] = useState<{ id: string | null; label: string | null } | null>(
    null,
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const currentValue = optimistic ? optimistic.id : value;
  const currentLabel = optimistic ? optimistic.label : valueLabel;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q),
    );
  }, [options, query]);

  // A synthetic "clear" row sits at the top of the list when offered, so it is
  // reachable by keyboard like any option. Its value is null. A "create" row is
  // appended when the caller supplies an onCreate handler and the current query
  // has no matching options.
  const rows: (SelectOption | { value: null; label: string } | { value: "__create__"; label: string })[] =
    useMemo(() => {
      const base: (SelectOption | { value: null; label: string } | { value: "__create__"; label: string })[] = [
        ...filtered,
      ];
      if (clearLabel && !query.trim()) base.unshift({ value: null, label: clearLabel });
      if (onCreate && query.trim() && filtered.length === 0) {
        const q = query.trim();
        base.push({
          value: "__create__",
          label: createLabel ? createLabel.replace("%s", q) : `Create “${q}”`,
        });
      }
      return base;
    }, [filtered, clearLabel, query, onCreate, createLabel]);

  // Close on an outside click.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Opening starts from a clean search each time. The input itself autoFocuses:
  // it only mounts while open, so there is nothing to focus until then.
  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setQuery("");
    setActive(0);
    setOpen(true);
  }

  // Keep the highlighted row in view as the arrow keys move it.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function choose(id: string | null, label: string | null) {
    if (id === "__create__") {
      const q = query.trim();
      setOpen(false);
      startTransition(async () => {
        await onCreate?.(q);
      });
      return;
    }
    setOptimistic({ id, label });
    setOpen(false);
    startTransition(async () => {
      await onSelect(id);
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) choose(row.value, row.value === null ? null : (row as SelectOption).label);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  // After the hooks, never before: an early return above them would change the
  // hook order between roles and break the rules of hooks.
  if (readOnly) {
    return (
      <span className={currentLabel ? "" : "text-muted"}>{currentLabel ?? "—"}</span>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className="inline-flex items-center gap-1.5 rounded border border-current/20 px-2 py-1 text-left hover:border-current/40 disabled:opacity-50"
      >
        <span className={currentLabel ? "" : "text-muted"}>
          {currentLabel ?? placeholder}
        </span>
        <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3 shrink-0 text-muted">
          <path
            d="M3 4.5 L6 7.5 L9 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div className="absolute z-10 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-current/20 bg-background shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search…"
            aria-label={`Search ${ariaLabel}`}
            className="w-full border-b border-current/15 bg-transparent px-3 py-2 text-sm outline-none"
          />
          <ul
            ref={listRef}
            role="listbox"
            className="max-h-64 overflow-y-auto py-1 text-sm"
          >
            {rows.length === 0 ? (
              <li className="px-3 py-2 text-muted">No matches</li>
            ) : (
              rows.map((row, i) => {
                const selected = row.value === currentValue;
                const isCreate = row.value === "__create__";
                const hint =
                  row.value !== null && !isCreate ? (row as SelectOption).hint : undefined;
                return (
                  <li
                    key={row.value ?? "__clear__"}
                    role="option"
                    aria-selected={selected}
                    onPointerEnter={() => setActive(i)}
                    onClick={() =>
                      choose(row.value, row.value === null ? null : (row as SelectOption).label)
                    }
                    className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 ${
                      i === active ? "bg-current/10" : ""
                    } ${row.value === null ? "text-muted italic" : ""} ${
                      isCreate ? "font-medium text-foreground" : ""
                    }`}
                  >
                    <span className="truncate">
                      {selected ? "✓ " : ""}
                      {isCreate ? "+ " : ""}
                      {row.label}
                    </span>
                    {hint ? <span className="shrink-0 text-xs text-muted">{hint}</span> : null}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
