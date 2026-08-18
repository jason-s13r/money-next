import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The reset token Better Auth would have emailed, handed to the caller instead.
 *
 * The link is what this app hands its owner: a password-reset link is generated
 * on demand and copied out of the members page, and mailing it as well is
 * optional and secondary (see the `sendResetPassword` note in ./index). Either
 * way the token has to be got hold of first, and `requestPasswordReset` is
 * deliberately enumeration-resistant — it answers identically whether or not the
 * email exists and returns nothing useful, exposing the freshly minted token
 * *only* to the `sendResetPassword` callback. So to surface the link we have to
 * catch the token as it passes through that callback.
 *
 * An `AsyncLocalStorage` is the race-free way to do it. Callers run
 * `requestPasswordReset` inside `withResetTokenCapture`; Better Auth invokes
 * `sendResetPassword` synchronously within that same async context — it `await`s
 * the callback rather than backgrounding it, because no
 * `advanced.backgroundTasks.handler` is configured — so `captureResetToken` finds
 * the active bucket and drops the token in. A concurrent request gets its own
 * bucket; a stray public POST to `/api/auth/request-password-reset` runs with no
 * bucket at all, so its token is generated, goes nowhere, and expires unused.
 *
 * No `server-only`: the CLI imports this from plain Node, where it throws.
 */
const bucket = new AsyncLocalStorage<{ token?: string }>();

/**
 * How long a reset token stays valid, in seconds. Better Auth's setting, but
 * kept out of ./index so a plain Node caller can read it without loading
 * `better-auth/next-js` — the outbox needs it to refuse to re-send a message
 * whose link has already died.
 */
export const RESET_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Called from `sendResetPassword`. Stashes the token if a capture is active, and
 * reports whether one was.
 *
 * That answer is load-bearing now that this instance can send mail. An active
 * bucket means the reset was asked for through one of *this app's* paths, since
 * those are the only callers that open one. No bucket means a bare POST to
 * `/api/auth/request-password-reset`, which Better Auth exposes publicly and this
 * app deliberately does not build a form for.
 *
 * So the caller emails only when this returns true. Otherwise adding a mailer
 * would have quietly turned that endpoint into a public forgot-password flow —
 * unauthenticated, able to mail a live reset link to any address it can guess at,
 * and shipped as a side effect of a delivery change rather than as a decision.
 */
export function captureResetToken(token: string): boolean {
  const store = bucket.getStore();
  if (!store) return false;
  store.token = token;
  return true;
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
