import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getSession, requireMfa } from "@/lib/server/auth/session";
import { EnrolForm } from "./enrol-form";

export const metadata: Metadata = { title: "Set up two-factor" };

/**
 * TOTP enrolment.
 *
 * Reachable two ways, which is the point of `REQUIRE_MFA` being enforcement
 * rather than capability: anyone may come here and turn on a second factor, and
 * when the flag is on, `requireUser()` sends unenrolled users here before they
 * reach any financial data.
 *
 * Checks the session by hand rather than calling `requireUser()`: that is the
 * function that redirects *here*, so calling it here is a loop.
 */
export default async function EnrolMfaPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // Already done. Nothing to enrol, and re-enrolling would silently invalidate
  // the authenticator they are using right now.
  if (session.user.twoFactorEnabled) redirect("/");

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-lg font-semibold">Set up two-factor</h1>
      <p className="mt-1 text-sm opacity-70">
        {requireMfa()
          ? "This instance requires a second factor before you can reach your data."
          : "Optional here, and worth it: this account can read your entire bank history."}
      </p>
      <EnrolForm />
    </main>
  );
}
