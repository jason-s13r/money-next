"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { replaceBankTokens } from "./actions";
import { NOT_SAVED, type ConnectBankState } from "./types";

export type ReplaceableLink = { id: string; name: string; status: string };

/**
 * Re-key an existing connection.
 *
 * This exists because of what the connect form does *after* it succeeds: the
 * link is created, so the form is gone, and a token pasted wrong is now a
 * permanent authentication failure with no in-app remedy. Without this the
 * likeliest mistake on the page was the one the page could not fix.
 *
 * **Styled to be ignorable.** The first version was a bordered `max-w-lg` card
 * centred above the run table, which gave a once-a-year repair the visual
 * weight of the page's main action and aligned it with nothing. It is now a
 * small line of muted text under a rule at the foot of the page — closer to
 * what it is, which is a footnote to the runs above it.
 *
 * Open when the last run failed, closed otherwise. That is the whole design: on
 * a healthy workspace nobody has to think about it, and on a broken one it is
 * already open directly beneath the failing run. It stays reachable either way,
 * because a token can be wrong without a failed run to point at — revoked at
 * Akahu, or a link that has never synced at all.
 */
export function ReplaceTokensForm({
  links,
  defaultOpen,
}: {
  links: ReplaceableLink[];
  defaultOpen: boolean;
}) {
  const [state, formAction] = useActionState<ConnectBankState, FormData>(
    replaceBankTokens,
    NOT_SAVED,
  );

  return (
    <details
      open={defaultOpen || state.saved || Boolean(state.error)}
      className="mt-10 border-t border-border pt-3"
    >
      <summary className="w-fit cursor-pointer text-xs text-muted hover:text-foreground">
        Replace Akahu tokens
      </summary>

      {state.saved ? (
        <p className="mt-3 max-w-prose text-sm text-muted">
          Replaced, and a sync is queued — including if this link was waiting out a retry, since
          asking for it counts as an override. The run above is what says whether the new pair
          works.
        </p>
      ) : (
        <form action={formAction} className="mt-3 flex max-w-sm flex-col gap-3">
          <p className="text-sm text-muted">
            If a sync is failing to authenticate, the stored pair is wrong or has been revoked at
            Akahu. Paste a new one — the old is overwritten, and nothing already imported is
            touched.
          </p>

          {/* One link is the normal case and a select of one is a puzzle, so it
              is a hidden field until there is a real choice to make. */}
          {links.length === 1 ? (
            <input type="hidden" name="linkId" value={links[0].id} />
          ) : (
            <label className="flex flex-col gap-1 text-sm">
              Connection
              <select
                name="linkId"
                defaultValue={links[0]?.id}
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              >
                {links.map((link) => (
                  <option key={link.id} value={link.id}>
                    {link.name} ({link.status.toLowerCase()})
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1 text-sm">
            Akahu app token
            <Input
              name="appToken"
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="app_token_…"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Akahu user access token
            <Input
              name="userToken"
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="user_token_…"
            />
          </label>

          <Submit />

          {state.error ? (
            <p role="alert" className="text-sm text-status-critical">
              {state.error}
            </p>
          ) : null}
        </form>
      )}
    </details>
  );
}

/** Separate so `useFormStatus` reads the form it is rendered inside. */
function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending} className="self-start">
      {pending ? "Replacing…" : "Replace tokens"}
    </Button>
  );
}
