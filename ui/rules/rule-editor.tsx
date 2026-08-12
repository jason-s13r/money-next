"use client";

import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelectField, type SelectOption } from "@/ui/primitives/searchable-select";
import { updateRule } from "@/app/w/[workspace]/rules/actions";
// Straight from ./edit rather than the learning barrel: that one carries
// `server-only`, and this is a client component.
import type { RuleEdit } from "@/lib/server/rules/learning/edit";

// Editing one learned rule in place on /rules.
//
// The tokens are the interesting half. A rule is derived from one transaction's
// description, and the tokeniser cannot tell a merchant's name from a reference
// that happens to look word-shaped — so a rule can arrive keyed on something like
// `3cb-kensingtonh`, which will never appear again. A person sees that instantly.
// Hence chips you can drop one at a time rather than a text field holding a ZEN
// expression: the edit that is nearly always wanted is "remove that one".
//
// Saving reports how many stored transactions the new predicate reaches, which is
// the only immediate evidence that widening it worked.

export type RuleCatalogs = {
  types: SelectOption[];
  categories: SelectOption[];
  merchants: SelectOption[];
  labels: SelectOption[];
};

export function RuleEditor({
  ruleId,
  initial,
  catalogs,
  onClose,
}: {
  ruleId: string;
  initial: RuleEdit;
  catalogs: RuleCatalogs;
  onClose: () => void;
}) {
  const [type, setType] = useState(initial.type);
  const [tokens, setTokens] = useState(initial.tokens);
  const [categoryId, setCategoryId] = useState(initial.categoryId);
  const [merchantId, setMerchantId] = useState(initial.merchantId);
  const [labelName, setLabelName] = useState(initial.labelName);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  // The label picker offers what already exists and lets a new name be typed, so
  // the catalog is topped up locally with whatever this rule already carries.
  const labelOptions = catalogs.labels.some((o) => o.value === labelName)
    ? catalogs.labels
    : [...catalogs.labels, ...(labelName ? [{ value: labelName, label: labelName }] : [])];

  function addToken(raw: string) {
    const token = raw.trim().toLowerCase();
    if (token === "") return;
    if (token.includes("'")) {
      setError("A word can’t contain an apostrophe.");
      return;
    }
    setError(null);
    setDraft("");
    if (!tokens.includes(token)) setTokens([...tokens, token]);
  }

  function onDraftKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addToken(draft);
    } else if (e.key === "Backspace" && draft === "" && tokens.length > 0) {
      // The usual tag-input courtesy: backspace on an empty field eats the last chip.
      setTokens(tokens.slice(0, -1));
    }
  }

  function save() {
    setError(null);
    startTransition(async () => {
      // Whatever is half-typed in the field counts — losing it to a click on Save
      // would be the more surprising outcome.
      const all = draft.trim() ? [...tokens, draft.trim().toLowerCase()] : tokens;
      const result = await updateRule(ruleId, {
        type,
        tokens: all,
        categoryId,
        merchantId,
        labelName,
      });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setTokens(all);
      setDraft("");
      setSaved(result.matchCount);
    });
  }

  return (
    <div className="w-full rounded border border-current/15 bg-current/[0.03] p-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,7rem)_minmax(0,1fr)] sm:items-start">
        <label className="pt-2 text-xs opacity-60" htmlFor={`type-${ruleId}`}>
          Type
        </label>
        <SearchableSelectField
          name={`type-${ruleId}`}
          options={catalogs.types}
          value={type}
          onChange={setType}
          clearLabel="Any type"
          placeholder="Any type"
          ariaLabel="Transaction type"
          className="max-w-64"
        />

        <span className="pt-2 text-xs opacity-60">Words</span>
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            {tokens.map((token) => (
              <Badge
                key={token}
                variant="secondary"
                className="gap-1 bg-accent font-mono text-accent-foreground"
              >
                {token}
                <button
                  type="button"
                  aria-label={`Remove word ${token}`}
                  disabled={pending}
                  onClick={() => setTokens(tokens.filter((t) => t !== token))}
                  className="-mr-0.5 rounded-full px-0.5 leading-none opacity-60 hover:opacity-100 disabled:opacity-40"
                >
                  ×
                </button>
              </Badge>
            ))}
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onDraftKeyDown}
              onBlur={() => addToken(draft)}
              disabled={pending}
              placeholder="Add a word…"
              aria-label="Add a word to match on"
              className="h-8 w-40"
            />
          </div>
          <p className="mt-1.5 text-xs text-muted">
            Every word must appear in the description, ignoring case.
          </p>
        </div>

        <label className="pt-2 text-xs opacity-60">Category</label>
        <SearchableSelectField
          name={`category-${ruleId}`}
          options={catalogs.categories}
          value={categoryId}
          onChange={setCategoryId}
          clearLabel="No category"
          placeholder="No category"
          ariaLabel="Category the rule sets"
          className="max-w-80"
        />

        <label className="pt-2 text-xs opacity-60">Merchant</label>
        <SearchableSelectField
          name={`merchant-${ruleId}`}
          options={catalogs.merchants}
          value={merchantId}
          onChange={setMerchantId}
          clearLabel="No merchant"
          placeholder="No merchant"
          ariaLabel="Merchant the rule sets"
          className="max-w-80"
        />

        <label className="pt-2 text-xs opacity-60">Label</label>
        <div>
          <SearchableSelectField
            name={`label-${ruleId}`}
            options={labelOptions}
            value={labelName}
            onChange={setLabelName}
            onCreate={(query) => setLabelName(query)}
            createLabel="Tag with “%s”"
            clearLabel="Automatic"
            placeholder="Automatic"
            ariaLabel="Label the rule applies"
            className="max-w-80"
          />
          <p className="mt-1.5 text-xs text-muted">
            Left automatic, changed transactions are tagged after what changed —
            <span className="font-mono"> category-rule-…</span>,
            <span className="font-mono"> merchant-rule-…</span>.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={pending}>
          {saved === null ? "Cancel" : "Done"}
        </Button>
        {error ? <span className="text-xs text-status-critical">{error}</span> : null}
        {error === null && saved !== null ? (
          <span className="text-xs text-muted">
            Saved — matches {saved.toLocaleString("en-NZ")}{" "}
            {saved === 1 ? "transaction" : "transactions"}.
          </span>
        ) : null}
      </div>
    </div>
  );
}
