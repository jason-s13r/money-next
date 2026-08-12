"use client";

import { useState } from "react";

import { removeRule } from "@/app/w/[workspace]/rules/actions";
import { RuleEditor, type RuleCatalogs } from "./rule-editor";
import { RuleOutputs } from "./rule-output";

// One row of /rules: the rule as a sentence, and — for anyone who can edit — the
// same rule as a form. A client component because the swap between the two is
// local state and nothing else on the page cares about it.
//
// A rule whose predicate was hand-written rather than derived (`structured`
// false) is shown as its raw expression and can only be deleted: the editor's
// vocabulary is a type plus words, and saving through it would silently discard
// whatever else that expression said.

export type RuleRowData = {
  id: string;
  type: string | null;
  tokens: string[];
  structured: boolean;
  raw: string;
  categoryId: string | null;
  merchantId: string | null;
  labelName: string | null;
  categoryLabel: string | null;
  merchantLabel: string | null;
};

const CHIP = "rounded bg-current/10 px-1.5 py-0.5 font-mono text-xs";

export function RuleRow({
  rule,
  catalogs,
  canEdit,
}: {
  rule: RuleRowData;
  catalogs: RuleCatalogs;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="py-3">
        <RuleEditor
          ruleId={rule.id}
          initial={{
            type: rule.type,
            tokens: rule.tokens,
            categoryId: rule.categoryId,
            merchantId: rule.merchantId,
            labelName: rule.labelName,
          }}
          catalogs={catalogs}
          onClose={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">
        <span className="opacity-50">When</span>
        {rule.type ? <span className={CHIP}>{rule.type}</span> : null}
        {rule.structured ? (
          rule.tokens.map((t) => (
            <span key={t} className={CHIP}>
              {t}
            </span>
          ))
        ) : (
          <code className="rounded bg-current/10 px-1.5 py-0.5 text-xs">{rule.raw}</code>
        )}
        <span className="opacity-50">→</span>
        <RuleOutputs
          categoryName={rule.categoryLabel}
          merchantName={rule.merchantLabel}
          labelName={rule.labelName}
        />
      </div>
      {canEdit ? (
        <div className="flex items-center gap-3">
          {rule.structured ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs opacity-70 underline-offset-2 transition-opacity hover:opacity-100 hover:underline"
            >
              Edit
            </button>
          ) : null}
          <form action={removeRule.bind(null, rule.id)}>
            <button
              type="submit"
              className="text-xs text-status-critical opacity-70 transition-opacity hover:opacity-100"
              aria-label="Delete rule"
            >
              Delete
            </button>
          </form>
        </div>
      ) : null}
    </li>
  );
}
