"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateProfile } from "./actions";
import { PROFILE_IDLE, type ProfileState } from "./types";

/**
 * Edit your own name and email address.
 *
 * `defaultValue`, not `value`: these are uncontrolled inputs seeded from the
 * current row, so a failed submit keeps whatever you typed rather than snapping
 * back. `autoComplete` points a password manager at the right stored fields.
 * Posts to a server action, so it works with JavaScript off.
 */
export function ProfileForm({ name, email }: { name: string; email: string }) {
  const [state, formAction] = useActionState<ProfileState, FormData>(updateProfile, PROFILE_IDLE);

  return (
    <form action={formAction} className="mt-6 flex max-w-sm flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Name
        <Input name="name" required defaultValue={name} autoComplete="name" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Email address
        <Input name="email" type="email" required defaultValue={email} autoComplete="email" />
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      {state.ok ? (
        <p role="status" className="text-sm text-status-good">
          Details saved.
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
      {pending ? "Saving…" : "Save details"}
    </Button>
  );
}
