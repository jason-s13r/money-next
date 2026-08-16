"use client";

import { useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { renameAccount } from "@/app/w/[workspace]/accounts/[accountId]/actions";
import { ACCOUNT_NAME_MAX_LENGTH } from "@/app/w/[workspace]/accounts/[accountId]/types";

// The account page's heading block — the name, the line of provider detail under
// it, and (for anyone who may rename) the same name as a form. A client component
// because the swap between the two is local state and nothing else on the page
// cares about it, the same shape `RuleRow` uses.
//
// It owns both lines rather than just the name because they are one fact told
// twice: the heading is what the household calls the account, and the line under
// it says what the bank calls it — but only while the two differ, which is the one
// moment that is worth knowing (someone comparing this page against their bank's
// own app needs to find the name the bank uses). Splitting them across the server
// page and this component would leave the two disagreeing for the moment between a
// rename and the router catching up.

export function AccountHeading({
  accountId,
  name,
  displayName: initialDisplayName,
  canEdit,
  logo,
  meta,
}: {
  accountId: string;
  /** The provider's own name, which a rename overrides but never replaces. */
  name: string;
  /** The household's name for it, or null where they haven't given one. */
  displayName: string | null;
  canEdit: boolean;
  /** The bank's logo, rendered on the server (next/image with a remote src). */
  logo: ReactNode;
  /** The provider detail under the heading: institution, type, account number. */
  meta: ReactNode;
}) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialDisplayName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const label = displayName?.trim() || name;

  function open() {
    // Start from what is stored, not from the label: pre-filling with the
    // provider's name would turn "give this a shorter name" into "edit this long
    // one", and would make a Save without typing anything an override that
    // freezes today's provider wording forever.
    setDraft(displayName ?? "");
    setError(null);
    setEditing(true);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await renameAccount(accountId, draft);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setDisplayName(result.displayName);
      setEditing(false);
    });
  }

  return (
    <>
      {editing ? (
        // The form replaces the heading rather than sitting inside it: a <form> is
        // flow content and an <h1> takes only phrasing content.
        <div className="flex items-start gap-3">
          {logo}
          <div className="min-w-0 flex-1">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
              className="flex flex-wrap items-center gap-2"
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={pending}
                autoFocus
                maxLength={ACCOUNT_NAME_MAX_LENGTH}
                placeholder={name}
                aria-label="Name for this account"
                className="h-9 w-full max-w-80 text-base"
              />
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={pending}
              >
                Cancel
              </Button>
            </form>
            {/* Says how to undo, in the only place someone looking to undo will be. */}
            <p className="mt-1.5 text-xs text-muted">
              Empty means use the name your bank gives it: {name}
            </p>
            {error ? <p className="mt-1.5 text-xs text-status-critical">{error}</p> : null}
          </div>
        </div>
      ) : (
        <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-semibold">
          {logo}
          {label}
          {canEdit ? (
            <button
              type="button"
              onClick={open}
              className="text-xs font-normal opacity-70 underline-offset-2 transition-opacity hover:opacity-100 hover:underline"
            >
              Rename
            </button>
          ) : null}
        </h1>
      )}

      <p className="mt-1 text-sm opacity-60">{meta}</p>
      {label !== name ? (
        <p className="mt-0.5 text-sm opacity-50">{name}</p>
      ) : null}
    </>
  );
}
