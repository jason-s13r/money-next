"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { signIn, type LoginState } from "./actions";

/**
 * The form posts to a server action, so it submits as a POST whether or not
 * React has hydrated — which is the point. See ./actions for what went wrong
 * when it didn't.
 *
 * Still a client component, only so the error can be rendered inline. With JS
 * off it degrades to a plain form post and a full page render, which is the same
 * flow with worse manners.
 */
export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(signIn, { error: null });

  return (
    <form action={formAction} className="mt-6 flex flex-col gap-3">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          name="email"
          type="email"
          required
          autoComplete="username"
          autoFocus
          className="rounded border border-current/20 bg-transparent px-2 py-1"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="rounded border border-current/20 bg-transparent px-2 py-1"
        />
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      <Submit idle="Sign in" busy="Signing in…" />
    </form>
  );
}

/**
 * Its own component because `useFormStatus` reports the status of the form it is
 * rendered *inside* — called in the parent it would always read false.
 */
function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-2 rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
    >
      {pending ? busy : idle}
    </button>
  );
}
