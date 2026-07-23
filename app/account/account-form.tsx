"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { changePassword } from "./actions";
import { IDLE, type AccountState } from "./types";

/**
 * Change your password: current password, then the new one.
 *
 * `autoComplete` is set precisely so a password manager offers the right thing
 * in each field — `current-password` to fill, `new-password` to generate and
 * save — and so it updates the stored credential rather than saving a second.
 * Posts to a server action, so it works with JavaScript off (see
 * app/login/actions for why a credentials form must be incapable of GETting).
 */
export function AccountForm() {
  const [state, formAction] = useActionState<AccountState, FormData>(changePassword, IDLE);

  return (
    <form action={formAction} className="mt-6 flex max-w-sm flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Current password
        <Input name="currentPassword" type="password" required autoComplete="current-password" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        New password
        <Input name="newPassword" type="password" required minLength={12} autoComplete="new-password" />
        <span className="text-xs opacity-70">At least 12 characters.</span>
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      {state.ok ? (
        <p role="status" className="text-sm text-status-good">
          Password changed. Any other signed-in devices have been signed out.
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
      {pending ? "Changing…" : "Change password"}
    </Button>
  );
}
