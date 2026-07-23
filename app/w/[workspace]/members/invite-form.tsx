"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { Role } from "@/lib/server/auth/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invite } from "./actions";
import { NO_ERROR, type MemberActionState } from "./types";

/**
 * Invite by email and role.
 *
 * On success the invite appears in the list above with its link — nothing is
 * emailed (lib/server/auth/index.ts explains why), so the owner copies the link
 * and sends it however they'd normally talk to the person. That is worth knowing
 * before you press the button, so the form says it.
 */
export function InviteForm({ roles }: { roles: readonly Role[] }) {
  const [state, formAction] = useActionState<MemberActionState, FormData>(invite, NO_ERROR);

  return (
    <form action={formAction} className="mt-4 flex flex-wrap items-end gap-3">
      <label className="flex flex-1 flex-col gap-1 text-sm">
        Email address
        <Input name="email" type="email" required autoComplete="off" />
      </label>

      <label className="flex flex-1 flex-col gap-1 text-sm">
        Name <span className="opacity-60">(optional)</span>
        {/* Just a convenience: it pre-fills the name on the signup form so the
            invitee doesn't restate what the owner already knew. They can change
            it, so it is never required here. */}
        <Input name="name" autoComplete="off" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Role
        {/* Native select — no shadcn Select is installed — styled to match the
            Input beside it (h-8, rounded-lg, border-input). */}
        <select
          name="role"
          defaultValue="viewer"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </label>

      <Submit />

      {state.error ? (
        <p role="alert" className="w-full text-sm text-status-critical">
          {state.error}
        </p>
      ) : null}

      <p className="w-full text-xs text-muted">
        No email is sent. The invitation appears above with a link to send them; it works once,
        for that address, and expires after three days.
      </p>
    </form>
  );
}

/** Separate so `useFormStatus` reads the form it is rendered inside. */
function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Inviting…" : "Invite"}
    </Button>
  );
}
