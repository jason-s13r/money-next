"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resetPassword } from "./actions";
import { NO_ERROR, type ResetState } from "./types";

/**
 * Choose a new password, given a valid reset token.
 *
 * The token is carried in a hidden field, straight from the link's query string.
 * There is no field for it and nothing to type — the person following the link
 * only picks a password. Like the login form, this posts to a server action, so
 * it submits whether or not React has hydrated, and the password never rides a
 * GET query string (see app/login/actions.ts for the bug that taught us that).
 */
export function ResetForm({ token }: { token: string }) {
  const [state, formAction] = useActionState<ResetState, FormData>(resetPassword, NO_ERROR);

  return (
    <form action={formAction} className="mt-6 flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />

      <label className="flex flex-col gap-1 text-sm">
        New password
        <Input
          name="password"
          type="password"
          required
          minLength={12}
          autoFocus
          autoComplete="new-password"
        />
        {/* The server enforces this; saying it here saves a round trip to learn it. */}
        <span className="text-xs opacity-70">At least 12 characters.</span>
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      <Submit />
    </form>
  );
}

/** Separate so `useFormStatus` reads the form it is rendered inside. */
function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="mt-2 self-start">
      {pending ? "Setting…" : "Set password"}
    </Button>
  );
}
