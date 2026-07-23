import type { Metadata } from "next";

import { requireUser } from "@/lib/server/auth/session";
import { AccountSection } from "./section";
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
export default async function AccountPage() {
  const user = await requireUser();

  return (
    <AccountSection title="Your details" description="The name and email address on your account.">
      <ProfileForm name={user.name} email={user.email} />
    </AccountSection>
  );
}
