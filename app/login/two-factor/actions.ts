"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/server/auth";
import { safeNext } from "@/lib/safe-next";

/**
 * The second factor. A server action for the same reason as sign-in: a form with
 * no method GETs, and a one-time code in the URL bar is still a credential in
 * the URL bar. See ../actions.
 */

export type TwoFactorState = { error: string | null };

export async function verify(
  _prev: TwoFactorState,
  formData: FormData,
): Promise<TwoFactorState> {
  const code = String(formData.get("code") ?? "").trim();
  const next = safeNext(formData.get("next"));
  // A backup code is the way back in from a lost phone. Better Auth burns it on
  // use, so each works exactly once.
  const useBackup = formData.get("backup") === "1";

  try {
    if (useBackup) {
      await auth.api.verifyBackupCode({ headers: await headers(), body: { code } });
    } else {
      await auth.api.verifyTOTP({ headers: await headers(), body: { code } });
    }
  } catch (error) {
    if (error instanceof APIError) {
      return { error: error.body?.message ?? "That code didn't work." };
    }
    throw error;
  }

  redirect(next ?? "/");
}
