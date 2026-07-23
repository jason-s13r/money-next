"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import type { Role } from "@/lib/server/auth/roles";
import { Button } from "@/components/ui/button";
import { cancelInvite, changeRole, removeMember } from "./actions";
import { NO_ERROR, type MemberActionState } from "./types";

/**
 * The per-row controls.
 *
 * `Role` is imported as a type and the option list arrives as a prop, so nothing
 * from lib/server/auth reaches the client bundle: a type annotation is erased at
 * build, but importing `ROLES` as a value would drag better-auth's access-control
 * module along with it. The page passes `ROLES` down instead — one definition of
 * the vocabulary, on the side that owns it.
 */

/**
 * Change a role on select. No save button: the select *is* the intent.
 *
 * **Controlled, not `defaultValue`.** That was the first version and it was
 * wrong in the worst way this page could be wrong: after a full page load every
 * select snapped to `owner` — not a random value, but the first `<option>`,
 * which is what a select falls back to when nothing is marked selected. So a
 * page whose entire job is to say who holds power told the owner that everyone
 * did, and it self-corrected on any client-side navigation, which is how it
 * survived being looked at.
 *
 * The server was never wrong — checked, both halves: the SSR'd HTML carried
 * `selected` on the correct option, and the RSC payload carried the correct role.
 * So this was always the client overriding good markup.
 *
 * What is *confirmed*, from react-dom's source: `updateOptions` ends with "if no
 * option matched the value, select the first non-disabled one". That is precisely
 * the observed symptom, and `owner` is first only because `ROLES` lists it first.
 * What is **not** confirmed is the exact path that got there — the two candidates
 * are React re-running that with no value for an uncontrolled select, and the
 * browser's own form-state restoration on a soft reload (Ctrl+R), which lands
 * before React does. Both are consistent with "reload breaks it, client-side
 * navigation doesn't". This comment does not claim to know which, because it
 * doesn't, and a plausible-sounding mechanism written down as fact is how this
 * file's neighbours have gone wrong twice already.
 *
 * The fix does not depend on knowing. `value` is re-asserted by React on every
 * render — mount, hydration and after — so any of those origins is overwritten
 * with the server's answer. The rule worth keeping is narrower than "prefer
 * controlled": **`defaultValue` is for a field whose truth is the user's; this
 * field's truth is the database's.** Anything a server render has an opinion
 * about should be `value`. (The role picker in ./invite-form is `defaultValue`
 * and correctly so — nobody has chosen yet, so there is no truth to contradict.)
 */
export function RoleSelect({
  memberId,
  role,
  roles,
}: {
  memberId: string;
  role: Role;
  roles: readonly Role[];
}) {
  const [state, formAction] = useActionState<MemberActionState, FormData>(changeRole, NO_ERROR);

  // What the select shows: the server's answer, until this user picks something
  // else, and the server's answer again the moment it changes under us (a
  // revalidation after a successful change, or another owner's edit arriving).
  const [chosen, setChosen] = useState<Role>(role);
  const [lastRole, setLastRole] = useState<Role>(role);
  if (lastRole !== role) {
    // Adjusting state during render, which is React's documented way to reset on
    // a prop change — an effect would paint the stale value first.
    setLastRole(role);
    setChosen(role);
  }

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="memberId" value={memberId} />
      <select
        name="role"
        value={chosen}
        aria-label="Role"
        // Submitting on change means the failure path matters: if the server
        // refuses, the select keeps showing what was picked, so the error text
        // beside it is the only thing telling the truth. It says why.
        onChange={(event) => {
          setChosen(event.target.value as Role);
          event.currentTarget.form?.requestSubmit();
        }}
        // Native select — no shadcn Select is installed — sized to sit inline
        // with the destructive Button beside it (h-7, like size="sm").
        className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      >
        {roles.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <Error message={state.error} />
    </form>
  );
}

export function RemoveMemberButton({
  memberId,
  name,
  self,
}: {
  memberId: string;
  name: string;
  self: boolean;
}) {
  const [state, formAction] = useActionState<MemberActionState, FormData>(removeMember, NO_ERROR);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="memberId" value={memberId} />
      <Error message={state.error} />
      <Submit
        idle="Remove"
        busy="Removing…"
        // Removing yourself is legitimate — it's how you leave — but it is also
        // the one click here you cannot undo without someone else's help.
        confirm={
          self
            ? "Remove yourself from this workspace? You'll need a new invitation to get back in."
            : `Remove ${name}? They lose access on their next request.`
        }
      />
    </form>
  );
}

export function CancelInviteButton({ invitationId }: { invitationId: string }) {
  const [state, formAction] = useActionState<MemberActionState, FormData>(cancelInvite, NO_ERROR);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="invitationId" value={invitationId} />
      <Error message={state.error} />
      <Submit idle="Cancel" busy="Cancelling…" confirm="Withdraw this invitation?" />
    </form>
  );
}

function Error({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-status-critical">
      {message}
    </p>
  );
}

/** Separate so `useFormStatus` reads the form it is rendered inside. */
function Submit({ idle, busy, confirm }: { idle: string; busy: string; confirm: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="destructive"
      size="sm"
      disabled={pending}
      onClick={(event) => {
        if (!window.confirm(confirm)) event.preventDefault();
      }}
    >
      {pending ? busy : idle}
    </Button>
  );
}
