import type { Metadata } from "next";

import { TwoFactorForm } from "./two-factor-form";

export const metadata: Metadata = { title: "Two-factor" };

/**
 * The second factor, server-validated — which is the part Akahu's accreditation
 * actually requires ("server validated multi-factor authentication"). Reaching
 * this page means the password was right and the session is still withheld: it
 * is Better Auth, not this page, that decides whether the code is good.
 */
export default async function TwoFactorPage(props: PageProps<"/login/two-factor">) {
  const { next } = await props.searchParams;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-lg font-semibold">Two-factor</h1>
      <p className="mt-1 text-sm opacity-70">
        Enter the six-digit code from your authenticator app.
      </p>
      <TwoFactorForm next={typeof next === "string" ? next : undefined} />
    </main>
  );
}
