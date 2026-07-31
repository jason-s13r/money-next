"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/server/auth";
import { safeNext } from "@/lib/safe-next";
import { apiErrorMessage, raw, text } from "@/lib/form-data";

/**
 * Signing in, as a server action rather than a `fetch` from an event handler.
 *
 * This is not a style preference — it is the fix for a real bug that shipped.
 * The form was `<form onSubmit={…}>` with no `method`, and a form without a
 * method **GETs**: submitting before React had hydrated (or with JS broken)
 * serialised the password into the query string, so it landed in the URL bar,
 * the browser history, and every access log along the way. `preventDefault`
 * cannot help, because it only runs once React is already listening.
 *
 * A credentials form must not merely *avoid* GET-submitting; it must be
 * incapable of it. `<form action={serverAction}>` posts, always, hydrated or
 * not — which is also why this whole flow now works with JavaScript off.
 *
 * `nextCookies()` (see lib/server/auth) is what lets Better Auth set the session
 * cookie from in here.
 */

export type LoginState = { error: string | null };

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = text(formData, "email");
  // `raw`, not `text`: a trailing space in a password is part of the password,
  // and trimming it here would refuse a credential the account was created with.
  const password = raw(formData, "password");
  const next = safeNext(formData.get("next"));

  let twoFactor = false;

  try {
    const result = await auth.api.signInEmail({
      headers: await headers(),
      body: { email, password },
    });

    // A user with TOTP enrolled is not signed in yet: the password was only the
    // first factor, and Better Auth withholds the session and says so rather
    // than throwing.
    twoFactor = "twoFactorRedirect" in result && result.twoFactorRedirect === true;
  } catch (error) {
    return { error: apiErrorMessage(error, "Could not sign in.") };
  }

  // Outside the try/catch: `redirect` works by throwing, and catching it here
  // would turn every successful login into an error message.
  if (twoFactor) {
    redirect(`/login/two-factor${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  }
  redirect(next ?? "/");
}
