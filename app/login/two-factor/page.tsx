import type { Metadata } from "next";
import { Suspense } from "react";

import { FormFallback } from "@/ui/primitives/form-fallback";
import { TwoFactorForm } from "./two-factor-form";

export const metadata: Metadata = { title: "Two-factor" };

/**
 * The second factor, server-validated — which is the part Akahu's accreditation
 * actually requires ("server validated multi-factor authentication"). Reaching
 * this page means the password was right and the session is still withheld: it
 * is Better Auth, not this page, that decides whether the code is good.
 */
export default function TwoFactorPage(props: PageProps<"/login/two-factor">) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-lg font-semibold">Two-factor</h1>
      <p className="mt-1 text-sm opacity-70">
        Enter the six-digit code from your authenticator app.
      </p>
      <Suspense fallback={<FormFallback fields={1} />}>
        <Form searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}

// Same shape as /login: `next` is carried through the form, so the promise goes
// down rather than being awaited above the instruction that tells you what to do.
async function Form({
  searchParams,
}: {
  searchParams: PageProps<"/login/two-factor">["searchParams"];
}) {
  const { next } = await searchParams;
  return <TwoFactorForm next={typeof next === "string" ? next : undefined} />;
}
