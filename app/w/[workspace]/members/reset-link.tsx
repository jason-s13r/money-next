"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { generateResetLink } from "./actions";
import { NO_RESET, type ResetLinkState } from "./types";

/**
 * Generate, then copy, a password-reset link for a member.
 *
 * Two clicks by design, and both are load-bearing. The first submits the form
 * and asks the server to mint a token (a network round trip). The second copies
 * the link — and `navigator.clipboard.writeText` only works inside a user
 * gesture, so it *cannot* be the tail of an async action; it has to be its own
 * click. So this shows "Reset password" until there's a token, then swaps to a
 * "Copy link" button, exactly like ./invite-link once an invite exists.
 *
 * The URL is built from `window.location.origin`, not a configured base URL, for
 * the same reason invite-link gives: the link only has to work for whoever is
 * looking at this page, and the origin they reached it on is by definition one
 * that resolves. A misconfigured `BETTER_AUTH_URL` can't silently poison it.
 */
export function ResetLinkButton({ userId, name }: { userId: string; name: string }) {
  const [state, formAction] = useActionState<ResetLinkState, FormData>(generateResetLink, NO_RESET);

  if (state.token) {
    return <CopyLink token={state.token} name={name} />;
  }

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      {state.error ? (
        <span role="alert" className="text-xs text-status-critical">
          {state.error}
        </span>
      ) : null}
      <Generate />
    </form>
  );
}

/** Separate so `useFormStatus` reads the form it is rendered inside. */
function Generate() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      {pending ? "Generating…" : "Reset password"}
    </Button>
  );
}

function CopyLink({ token, name }: { token: string; name: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}/reset-password?token=${encodeURIComponent(token)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access needs a secure context and can be refused. Prompting
      // with the URL selected beats a button that does nothing.
      window.prompt(`Copy this reset link for ${name}`, url);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        {copied ? "Copied" : "Copy reset link"}
      </Button>
      {/* The link is a one-time, one-hour bearer credential — worth saying so the
          owner sends it promptly and to the right person. */}
      <span className="text-xs text-muted">works once · expires in 1 hour</span>
    </div>
  );
}
