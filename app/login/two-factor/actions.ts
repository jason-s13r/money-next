"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/server/auth";
import { safeNext } from "@/lib/safe-next";
import { apiErrorMessage, text } from "@/lib/form-data";

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
  const code = text(formData, "code");
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
    return { error: apiErrorMessage(error, "That code didn't work.") };
  }

  redirect(next ?? "/");
}
