"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/server/auth";

/**
 * TOTP enrolment, in two server actions.
 *
 * Step 1 takes the account password — so it carries exactly the same "a form
 * with no method GETs" hazard as sign-in, and gets the same answer. See
 * ../login/actions.
 */

export type EnrolState = {
  error: string | null;
  started: { secret: string; codes: string[] } | null;
};

/** Step 1: mint a secret and backup codes. Nothing is enforced until step 2. */
export async function start(_prev: EnrolState, formData: FormData): Promise<EnrolState> {
  const password = String(formData.get("password") ?? "");

  try {
    const data = await auth.api.enableTwoFactor({
      headers: await headers(),
      body: { password },
    });

    // The URI is `otpauth://totp/…?secret=…`. Only the secret is shown, for
    // typing into an authenticator by hand — no QR code, because rendering one
    // needs a QR library and this instance enrols a household. If enrolment ever
    // happens at scale, add one here and nothing else changes.
    const secret = new URL(data.totpURI).searchParams.get("secret") ?? "";
    return { error: null, started: { secret, codes: data.backupCodes } };
  } catch (error) {
    // Asking for the password is Better Auth's rule and a good one: it means a
    // borrowed unlocked laptop cannot quietly add an attacker's authenticator.
    if (error instanceof APIError) {
      return { error: error.body?.message ?? "Could not start enrolment.", started: null };
    }
    throw error;
  }
}

/**
 * Step 2: prove the secret actually reached the authenticator.
 *
 * Only now does `twoFactorEnabled` become true and the factor start being
 * demanded at sign-in — which is what stops a half-finished enrolment locking
 * someone out of their own account.
 */
export async function confirm(_prev: EnrolState, formData: FormData): Promise<EnrolState> {
  const code = String(formData.get("code") ?? "").trim();

  // Carried through the round trip so a failed code doesn't lose the codes the
  // user is midway through writing down.
  const secret = String(formData.get("secret") ?? "");
  const codes = formData.getAll("codes").map(String);

  try {
    await auth.api.verifyTOTP({ headers: await headers(), body: { code } });
  } catch (error) {
    if (error instanceof APIError) {
      return {
        error: error.body?.message ?? "That code didn't work. Check your app's clock.",
        started: { secret, codes },
      };
    }
    throw error;
  }

  redirect("/");
}
