import type { Metadata } from "next";
import { Suspense } from "react";

import { requireUser } from "@/lib/server/auth/session";
import { AccountSection } from "./section";
import { FormFallback } from "@/ui/primitives/form-fallback";
import { ProfileForm } from "./profile-form";

export const metadata: Metadata = { title: "Account details" };

/**
 * Your name and email address — the landing page of the account area.
 *
 * Top-level, above `/w/[workspace]/`, because your identity belongs to the
 * person, not to any one workspace, and someone with no workspace at all must
 * still reach it. `requireUser` is the gate — a session, nothing about a
 * workspace. The sidebar chrome and the "works without a workspace" guarantee
 * live in app/account/layout.
 */
export default function AccountPage() {
  return (
    <AccountSection title="Your details" description="The name and email address on your account.">
      <Suspense fallback={<FormFallback fields={2} className="max-w-sm" />}>
        <Profile />
      </Suspense>
    </AccountSection>
  );
}

// The gate still gates: nothing it protects renders until it has resolved. Only
// its *position* moved, below the boundary, so the heading above ships instantly.
async function Profile() {
  const user = await requireUser();
  return <ProfileForm name={user.name} email={user.email} />;
}
