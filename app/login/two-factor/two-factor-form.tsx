"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
        <Input
          name="code"
          required
          autoFocus
          autoComplete="one-time-code"
          inputMode={backup ? "text" : "numeric"}
          className="font-mono"
        />
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      <Submit />

      <Button
        type="button"
        variant="link"
        size="sm"
        onClick={() => setBackup((b) => !b)}
        className="self-start px-0 text-xs text-muted-foreground"
      >
        {backup ? "Use your authenticator app instead" : "Lost your phone? Use a backup code"}
      </Button>
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="mt-2">
      {pending ? "Checking…" : "Verify"}
    </Button>
  );
}
