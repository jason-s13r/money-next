"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { Role } from "@/lib/server/auth/roles";
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
        <input
          name="email"
          type="email"
          required
          autoComplete="off"
          className="rounded border border-current/20 bg-transparent px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Role
        <select
          name="role"
          defaultValue="viewer"
          className="rounded border border-current/20 bg-transparent px-2 py-1.5"
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
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
    >
      {pending ? "Inviting…" : "Invite"}
    </button>
  );
}
