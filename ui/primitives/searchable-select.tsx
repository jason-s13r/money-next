"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";

export type SelectOption = {
  value: string;
  label: string;
  /** Secondary text shown dimmed beside the label, e.g. a category's group. */
  hint?: string;
};

/** A row in the open list: an option, the synthetic "clear", or the "create". */
type Row =
  | SelectOption
  | { value: null; label: string }
  | { value: "__create__"; label: string };

/**
 * The combobox itself: a button showing the current value that opens a filterable
 * list. Built from a plain <input> and <ul> rather than a library — the app carries
 * no headless-ui dependency, and one accessible listbox is cheaper than one.
 *
 * The full option set is handed over from the server and filtered on the client.
 * At this app's scale (a few hundred categories, similar order of merchants) that
 * is a trivial payload and instant to type against; a server-round-trip typeahead
 * would be more machinery for no felt benefit.
 *
 * Purely controlled, and unaware of what a choice is for — the two exports below
 * layer that on: `SearchableSelect` runs a server action, `SearchableSelectField`
 * fills a form field.
 */
function Combobox({
  options,
  value,
  valueLabel,
  onChoose,
  onCreate,
  createLabel,
  placeholder,
  clearLabel,
  ariaLabel,
  disabled = false,
  triggerClassName,
  valueClassName = "",
  panelClassName = "w-72",
}: {
  options: SelectOption[];
  value: string | null;
  valueLabel: string | null;
  onChoose: (value: string | null, label: string | null) => void;
  onCreate?: (query: string) => void;
  createLabel?: string;
  placeholder: string;
  clearLabel?: string;
  ariaLabel: string;
  disabled?: boolean;
  triggerClassName: string;
  /** Extra classes on the value text — `truncate` where the trigger has a width. */
  valueClassName?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  // Whether the panel opens above the trigger rather than below — decided on open
  // from the room left under the button, so a picker near the bottom of the
  // viewport (e.g. the selection bulk bar) isn't clipped.
  const [dropUp, setDropUp] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

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
  const rows: Row[] = useMemo(() => {
    const base: Row[] = [...filtered];
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

  // Keep the highlighted row in view as the arrow keys move it.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // Opening starts from a clean search each time. The input itself autoFocuses:
  // it only mounts while open, so there is nothing to focus until then.
  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    // Flip upward when the space below the trigger can't hold the panel and there
    // is more room above. ~320px covers the search input plus the list's max
    // height and margins.
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom;
      setDropUp(spaceBelow < 320 && rect.top > spaceBelow);
    }
    setQuery("");
    setActive(0);
    setOpen(true);
  }

  function choose(row: Row) {
    setOpen(false);
    if (row.value === "__create__") {
      onCreate?.(query.trim());
      return;
    }
    onChoose(row.value, row.value === null ? null : row.label);
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
      if (row) choose(row);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={triggerClassName}
      >
        <span className={`${valueClassName} ${valueLabel ? "" : "text-muted"}`}>
          {valueLabel ?? placeholder}
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
        <div
          className={`absolute z-10 max-w-[calc(100vw-2rem)] rounded-md border border-current/20 bg-background shadow-lg ${panelClassName} ${
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
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
          <ul ref={listRef} role="listbox" className="max-h-64 overflow-y-auto py-1 text-sm">
            {rows.length === 0 ? (
              <li className="px-3 py-2 text-muted">No matches</li>
            ) : (
              rows.map((row, i) => {
                const selected = row.value === value;
                const isCreate = row.value === "__create__";
                const hint =
                  row.value !== null && !isCreate ? (row as SelectOption).hint : undefined;
                return (
                  <li
                    key={row.value ?? "__clear__"}
                    role="option"
                    aria-selected={selected}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => choose(row)}
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

/** The inline trigger: a small bordered chip, sized to whatever it sits beside. */
const CHIP_TRIGGER =
  "inline-flex items-center gap-1.5 rounded border border-current/20 px-2 py-1 text-left hover:border-current/40 disabled:opacity-50";

/**
 * A combobox that writes its choice straight through to the server.
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
  const [pending, startTransition] = useTransition();
  // Show the just-chosen label immediately; falls back to the server's value.
  const [optimistic, setOptimistic] = useState<{ id: string | null; label: string | null } | null>(
    null,
  );

  const currentValue = optimistic ? optimistic.id : value;
  const currentLabel = optimistic ? optimistic.label : valueLabel;

  // After the hooks, never before: an early return above them would change the
  // hook order between roles and break the rules of hooks.
  if (readOnly) {
    return <span className={currentLabel ? "" : "text-muted"}>{currentLabel ?? "—"}</span>;
  }

  return (
    <Combobox
      options={options}
      value={currentValue}
      valueLabel={currentLabel}
      onChoose={(id, label) => {
        setOptimistic({ id, label });
        startTransition(async () => {
          await onSelect(id);
        });
      }}
      onCreate={
        onCreate
          ? (query) => {
              startTransition(async () => {
                await onCreate(query);
              });
            }
          : undefined
      }
      createLabel={createLabel}
      placeholder={placeholder}
      clearLabel={clearLabel}
      ariaLabel={ariaLabel}
      disabled={pending}
      triggerClassName={CHIP_TRIGGER}
    />
  );
}

/**
 * The same combobox as a form field: a controlled value plus the hidden input
 * that carries it in the `FormData`, styled to sit beside `Input` in a form.
 *
 * The display text comes from `options`, not from a second prop — a form holds
 * the whole catalog anyway, so there is no denormalised name to prefer and no way
 * for the label to drift from the value. An empty value posts an empty string,
 * which every action here already reads as "not set".
 */
export function SearchableSelectField({
  name,
  options,
  value,
  onChange,
  onCreate,
  createLabel,
  placeholder = "Choose…",
  clearLabel,
  ariaLabel,
  className = "",
}: {
  name: string;
  options: SelectOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  /**
   * When present, a non-empty search with no matches offers a row that creates
   * one. Only meaningful for a field whose value *is* its text — a label, which is
   * stored by name — since there is no id to mint here.
   */
  onCreate?: (query: string) => void;
  /** Label for the create row. Use `%s` as a placeholder for the query. */
  createLabel?: string;
  placeholder?: string;
  /** When present, an entry that unsets the value (e.g. "Any"). */
  clearLabel?: string;
  ariaLabel: string;
  className?: string;
}) {
  // Falls back to the value itself: a created option is chosen before the caller
  // has had a chance to put it in `options`.
  const label = options.find((o) => o.value === value)?.label ?? value;

  return (
    <div className={className}>
      <input type="hidden" name={name} value={value ?? ""} />
      <Combobox
        options={options}
        value={value}
        valueLabel={label}
        onChoose={(id) => onChange(id)}
        onCreate={onCreate}
        createLabel={createLabel}
        placeholder={placeholder}
        clearLabel={clearLabel}
        ariaLabel={ariaLabel}
        triggerClassName="flex h-9 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
        valueClassName="truncate"
        panelClassName="w-full min-w-64"
      />
    </div>
  );
}
