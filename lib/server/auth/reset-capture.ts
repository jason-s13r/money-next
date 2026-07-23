import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The reset token Better Auth would have emailed, handed to the caller instead.
 *
 * This instance sends no mail (see the `sendResetPassword` note in ./index): a
 * password-reset link is generated on demand by a workspace owner and delivered
 * by hand, the same posture as invites. But `requestPasswordReset` is
 * deliberately enumeration-resistant — it answers identically whether or not the
 * email exists and returns nothing useful, exposing the freshly minted token
 * *only* to the `sendResetPassword` callback. So to surface the link we have to
 * catch the token as it passes through that callback.
 *
 * An `AsyncLocalStorage` is the race-free way to do it. The owner action (and the
 * `user:password` script) run `requestPasswordReset` inside `withResetTokenCapture`;
 * Better Auth invokes `sendResetPassword` synchronously within that same async
 * context — it `await`s the callback rather than backgrounding it, because no
 * `advanced.backgroundTasks.handler` is configured — so `captureResetToken` finds
 * the active bucket and drops the token in. A concurrent request gets its own
 * bucket; a stray public POST to `/api/auth/request-password-reset` runs with no
 * bucket at all, so its token is generated, goes nowhere, and expires unused.
 *
 * Not `server-only`: `scripts/set-password.ts` imports this from a plain Node
 * process, and `server-only` throws outside a bundler's react-server condition.
 * It is server code by where it is called from, not by a guard.
 */
const bucket = new AsyncLocalStorage<{ token?: string }>();

/** Called from `sendResetPassword`. Stashes the token if a capture is active. */
export function captureResetToken(token: string): void {
  const store = bucket.getStore();
  if (store) store.token = token;
}

/**
 * Run `request` (a call to `auth.api.requestPasswordReset`) and return the reset
 * token it generated, or `null` if none was — an unknown email, or reset being
 * misconfigured, both of which `requestPasswordReset` swallows silently.
 */
export async function withResetTokenCapture(request: () => Promise<unknown>): Promise<string | null> {
  const store: { token?: string } = {};
  await bucket.run(store, request);
  return store.token ?? null;
}
