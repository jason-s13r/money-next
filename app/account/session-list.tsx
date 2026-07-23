"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { revokeOtherSessions, revokeSession } from "./actions";
import { IDLE, type AccountState } from "./types";

/**
 * Your live sessions, one row per device, with a way to end any but this one.
 *
 * The data is display-ready by the time it arrives: the server formats the dates
 * and summarises each user-agent, and — the part that matters — it sends each
 * row's *id*, never its token. A session token is the credential itself, so the
 * revoke action re-resolves the token from the id server-side; nothing here ever
 * holds one (see app/account/actions.ts).
 */
export type SessionView = {
  id: string;
  current: boolean;
  device: string;
  ip: string;
  signedIn: string;
  expires: string;
};

export function SessionList({ sessions }: { sessions: SessionView[] }) {
  const others = sessions.filter((s) => !s.current);

  return (
    <div className="mt-6 flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-current/10 rounded-lg border border-current/10">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-center justify-between gap-4 p-3">
            <div className="min-w-0 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{session.device}</span>
                {session.current ? (
                  <span className="rounded bg-status-good/15 px-1.5 py-0.5 text-xs text-status-good">
                    This device
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 text-xs opacity-60">
                {session.ip} · signed in {session.signedIn} · expires {session.expires}
              </div>
            </div>

            {session.current ? null : <RevokeButton sessionId={session.id} />}
          </li>
        ))}
      </ul>

      {others.length > 0 ? <RevokeOthers /> : null}
    </div>
  );
}

/** Ends one other session. Its own `useActionState` so a failure shows on its row. */
function RevokeButton({ sessionId }: { sessionId: string }) {
  const [state, formAction] = useActionState<AccountState, FormData>(revokeSession, IDLE);

  return (
    <form action={formAction} className="shrink-0 text-right">
      <input type="hidden" name="sessionId" value={sessionId} />
      <RevokeSubmit label="Sign out" busy="Signing out…" variant="outline" />
      {state.error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** Ends every session but this one. */
function RevokeOthers() {
  const [state, formAction] = useActionState<AccountState, FormData>(revokeOtherSessions, IDLE);

  return (
    <form action={formAction} className="self-start">
      <RevokeSubmit label="Sign out other devices" busy="Signing out…" variant="outline" />
      {state.error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

function RevokeSubmit({
  label,
  busy,
  variant,
}: {
  label: string;
  busy: string;
  variant: "outline";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {pending ? busy : label}
    </Button>
  );
}
