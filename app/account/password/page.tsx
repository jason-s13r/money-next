import type { Metadata } from "next";
import { Suspense } from "react";

import { requireUser } from "@/lib/server/auth/session";
import { AccountSection } from "../section";
import { AccountForm } from "../account-form";
import { FormFallback } from "@/ui/primitives/form-fallback";

export const metadata: Metadata = { title: "Password" };

/**
 * Change your own password. The gate is `requireUser` (a session), and the form
 * itself demands your current password — the real control, which is why this is
 * account-level rather than workspace-scoped (see app/account/actions).
 */
export default function PasswordPage() {
  return (
    <AccountSection
      title="Change your password"
      description="You'll need your current password to set a new one."
    >
      <Suspense fallback={<FormFallback fields={2} className="max-w-sm" />}>
        <GatedForm />
      </Suspense>
    </AccountSection>
  );
}

// The form takes nothing from the session — `requireUser` is here purely as the
// gate, so it is kept and simply awaited below the boundary rather than dropped.
async function GatedForm() {
  await requireUser();
  return <AccountForm />;
}
