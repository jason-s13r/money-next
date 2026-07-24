"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { connectBank } from "./actions";
import { NOT_SAVED, type ConnectBankState } from "./types";

/**
 * Paste a personal Akahu token pair to connect this workspace's bank.
 *
 * Rendered only when there is no link and only to an owner (see page.tsx) — the
 * empty state of the sync page, rather than a settings screen that would be
 * blank for everyone who is already connected.
 *
 * **The tokens are treated as credentials, not as text.** `type="password"` so a
 * shoulder or a screen share does not get one, `autoComplete="off"` so the
 * browser does not offer to remember a bank credential the way it would an
 * email, and `spellCheck={false}` so it is never sent anywhere for checking.
 * Nothing is echoed back on failure either: the action returns a message, never
 * the value, so a re-render cannot repopulate a field with a token that went to
 * the server and back.
 */
export function ConnectBankForm() {
  const [state, formAction] = useActionState<ConnectBankState, FormData>(
    connectBank,
    NOT_SAVED,
  );

  // The success state is deliberately not a redirect. The sync this queued is
  // the only verification that exists — the web app cannot call Akahu — so the
  // useful next thing to look at is the run table right below, which refreshes
  // itself until the worker finishes.
  if (state.saved) {
    return (
      <section className="mx-auto mt-8 max-w-lg rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold">Bank connected</h2>
        <p className="mt-2 text-sm text-muted">
          A sync is queued. It is the first thing to actually use these tokens, so if either
          was wrong or belongs to a different Akahu account, the run below will say so within
          a few seconds.
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto mt-8 max-w-lg rounded-lg border border-border p-4">
      <h2 className="text-sm font-semibold">Connect a bank</h2>
      <p className="mt-1 text-sm text-muted">
        This workspace has no bank connected, so there is nothing to sync yet. Paste a personal
        token pair from{" "}
        <a
          href="https://my.akahu.nz"
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2"
        >
          my.akahu.nz
        </a>
        .
      </p>

      <form action={formAction} className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Name
          <Input name="name" required autoComplete="off" placeholder="e.g. Everyday accounts" />
          <span className="text-xs text-muted">What you call this connection.</span>
        </label>

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

        {/* Worth saying before the paste, not after: the app can store a token
            and can never read one back, and it cannot check the pair either —
            the queued sync is the check. Both are consequences of the same
            arrangement (docs/multi-user.md), and both change what someone
            should expect to happen next. */}
        <p className="text-xs text-muted">
          Stored encrypted, sealed to a key only the sync worker holds — the app can save a token
          but never read one back, and no one can recover it from here. Saving queues a sync,
          which is what verifies the pair.
        </p>
      </form>
    </section>
  );
}

/** Separate so `useFormStatus` reads the form it is rendered inside. */
function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="self-start">
      {pending ? "Connecting…" : "Connect"}
    </Button>
  );
}
