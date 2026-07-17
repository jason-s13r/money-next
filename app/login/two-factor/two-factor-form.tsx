"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { verify, type TwoFactorState } from "./actions";

export function TwoFactorForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<TwoFactorState, FormData>(verify, {
    error: null,
  });
  const [backup, setBackup] = useState(false);

  return (
    <form action={formAction} className="mt-6 flex flex-col gap-3">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <input type="hidden" name="backup" value={backup ? "1" : "0"} />

      <label className="flex flex-col gap-1 text-sm">
        {backup ? "Backup code" : "Code"}
        <input
          name="code"
          required
          autoFocus
          autoComplete="one-time-code"
          inputMode={backup ? "text" : "numeric"}
          className="rounded border border-current/20 bg-transparent px-2 py-1 font-mono"
        />
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      <Submit />

      <button
        type="button"
        onClick={() => setBackup((b) => !b)}
        className="text-xs underline opacity-60 hover:opacity-100"
      >
        {backup ? "Use your authenticator app instead" : "Lost your phone? Use a backup code"}
      </button>
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-2 rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
    >
      {pending ? "Checking…" : "Verify"}
    </button>
  );
}
