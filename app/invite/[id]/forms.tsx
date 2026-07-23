"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { acceptInvite, signUpFromInvite } from "./actions";
import { NO_ERROR, type InviteState } from "./types";

/**
 * Create the account the invite was addressed to.
 *
 * The email is shown, not collected. There is no field for it and no hidden
 * input carrying it, because the action reads it from the invite row and would
 * ignore one anyway — a disabled input would suggest the address is this form's
 * to state, and it isn't. The only thing this form contributes is a name and a
 * password; who the account is for was decided when the invite was sent.
 */
export function SignUpForm({
  inviteId,
  email,
  name,
}: {
  inviteId: string;
  email: string;
  /** Pre-filled from the invite when the owner typed one; still the invitee's to change. */
  name?: string | null;
}) {
  const [state, formAction] = useActionState<InviteState, FormData>(signUpFromInvite, NO_ERROR);

  return (
    <form action={formAction} className="mt-6 flex flex-col gap-3">
      <input type="hidden" name="inviteId" value={inviteId} />

      <div className="text-sm">
        <span className="opacity-70">Signing up as</span>{" "}
        <strong className="font-medium">{email}</strong>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        Your name
        {/* `defaultValue`, not `value`: the owner's guess is a starting point the
            invitee edits, not a controlled field. `autoFocus` still lands here so
            they can correct it immediately. */}
        <Input name="name" required autoFocus autoComplete="name" defaultValue={name ?? ""} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Choose a password
        <Input name="password" type="password" required minLength={12} autoComplete="new-password" />
        {/* The server enforces this; saying it here saves a round trip to learn it. */}
        <span className="text-xs opacity-70">At least 12 characters.</span>
      </label>

      <Error message={state.error} />

      <Submit idle="Create account" busy="Creating…" />
    </form>
  );
}

/** One button. Everything it needs to decide was decided before the page rendered. */
export function AcceptForm({ inviteId, workspace }: { inviteId: string; workspace: string }) {
  const [state, formAction] = useActionState<InviteState, FormData>(acceptInvite, NO_ERROR);

  return (
    <form action={formAction} className="mt-6 flex flex-col gap-3">
      <input type="hidden" name="inviteId" value={inviteId} />

      <Error message={state.error} />

      <Submit idle={`Join ${workspace}`} busy="Joining…" />
    </form>
  );
}

function Error({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-red-600">
      {message}
    </p>
  );
}

/** Separate so `useFormStatus` reads the form it is rendered inside. */
function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="self-start">
      {pending ? busy : idle}
    </Button>
  );
}
