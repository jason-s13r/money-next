import type { Metadata } from "next";

import { requireUser } from "@/lib/server/auth/session";
import { AccountSection } from "../section";
import { AccountForm } from "../account-form";

export const metadata: Metadata = { title: "Password" };

/**
 * Change your own password. The gate is `requireUser` (a session), and the form
 * itself demands your current password — the real control, which is why this is
 * account-level rather than workspace-scoped (see app/account/actions).
 */
export default async function PasswordPage() {
  await requireUser();

  return (
    <AccountSection
      title="Change your password"
      description="You'll need your current password to set a new one."
    >
      <AccountForm />
    </AccountSection>
  );
}
