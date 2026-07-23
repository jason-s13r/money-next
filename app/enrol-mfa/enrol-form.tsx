"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirm, start, type EnrolState } from "./actions";

const EMPTY: EnrolState = { error: null, started: null };

/**
 * Enrolment in two steps, because it must not be possible to lock yourself out
 * by half-finishing it: the secret exists after step 1, but nothing demands it
 * until step 2 proves the authenticator has it.
 *
 * Both steps post to server actions, so neither the password nor the code can
 * end up in a URL — see ./actions.
 */
export function EnrolForm() {
  const [state, formAction] = useActionState<EnrolState, FormData>(start, EMPTY);

  if (!state.started) {
    return (
      <form action={formAction} className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Confirm your password
          <Input name="password" type="password" required autoFocus autoComplete="current-password" />
        </label>

        {state.error ? (
          <p role="alert" className="text-sm text-red-600">
            {state.error}
          </p>
        ) : null}

        <Submit idle="Start" busy="Starting…" />
      </form>
    );
  }

  return <Confirm started={state.started} />;
}

function Confirm({ started }: { started: NonNullable<EnrolState["started"]> }) {
  const [state, formAction] = useActionState<EnrolState, FormData>(confirm, {
    error: null,
    started,
  });
  const current = state.started ?? started;

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div>
        <p className="text-sm">Add this secret to your authenticator app:</p>
        <code className="mt-1 block overflow-x-auto rounded bg-current/5 p-2 font-mono text-sm">
          {current.secret}
        </code>
      </div>

      <div>
        <p className="text-sm">
          Save these backup codes somewhere that isn&rsquo;t your phone. Each works once, and
          they are the only way back in if you lose the authenticator.
        </p>
        <ul className="mt-1 grid grid-cols-2 gap-1 rounded bg-current/5 p-2 font-mono text-sm">
          {current.codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </div>

      <form action={formAction} className="flex flex-col gap-3">
        {/* Carried so a mistyped code doesn't discard the codes mid-transcription. */}
        <input type="hidden" name="secret" value={current.secret} />
        {current.codes.map((code) => (
          <input key={code} type="hidden" name="codes" value={code} />
        ))}

        <label className="flex flex-col gap-1 text-sm">
          Enter a code from the app to finish
          <Input
            name="code"
            required
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            className="font-mono"
          />
        </label>

        {state.error ? (
          <p role="alert" className="text-sm text-red-600">
            {state.error}
          </p>
        ) : null}

        <Submit idle="Finish" busy="Checking…" />
      </form>
    </div>
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
