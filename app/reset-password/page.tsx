import type { Metadata } from "next";

import { ResetForm } from "./reset-form";

export const metadata: Metadata = { title: "Reset password" };

/**
 * Where a reset link lands.
 *
 * Two shapes an owner (or the account holder) sends someone to: with a `token`
 * in the query, this shows the form to choose a new password; without one, the
 * link was mangled or truncated in transit, and there is nothing to do but ask
 * for another. This page does *not* validate the token — a token can be well-
 * formed and still be expired, used, or forged, and only Better Auth can say so
 * as it consumes it. So the real check is in the action (./actions), and this
 * page only decides whether there is a token to try at all. That is the same
 * split as the invite page: render on what's cheap to know, enforce on what
 * isn't.
 *
 * Public (proxy.ts's PUBLIC_PATHS), because the person most likely to need it
 * is the one who cannot sign in. Resetting the password does not sign them in
 * either — the action sends them to /login to use it, and a session is minted
 * only when they do.
 */
export default async function ResetPasswordPage(props: PageProps<"/reset-password">) {
  const { token } = await props.searchParams;
  const value = typeof token === "string" ? token : "";

  if (!value) {
    return (
      <Shell title="This reset link is incomplete">
        <p className="text-sm opacity-70">
          It may have been truncated when it was copied or sent. Ask whoever gave you the link
          to generate a new one.
        </p>
      </Shell>
    );
  }

  return (
    <Shell title="Choose a new password">
      <p className="text-sm opacity-70">
        Set a new password below. The link works once — after this, use the new password to sign
        in.
      </p>
      <ResetForm token={value} />
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-lg font-semibold">{title}</h1>
      <div className="mt-2">{children}</div>
    </main>
  );
}
