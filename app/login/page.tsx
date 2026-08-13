import type { Metadata } from "next";
import { Suspense } from "react";

import { FormFallback } from "@/ui/primitives/form-fallback";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

/**
 * There is no "sign up" link, and that is the design rather than an omission:
 * registration is invite-only (docs/multi-user.md), so an account is only ever
 * born from an invite link or the bootstrap script. There is no open signup path
 * to disable later, and no signup form for anyone to find.
 */
export default function LoginPage(props: PageProps<"/login">) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-lg font-semibold">Money</h1>
      <p className="mt-1 text-sm opacity-70">Sign in to continue.</p>
      <Suspense fallback={<FormFallback fields={2} />}>
        <Form searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}

// `next` is the only per-request thing on this page, and only the form wants it,
// so the promise is forwarded rather than awaited above — the wordmark and the
// invitation to sign in do not need to wait on a query string to be known.
async function Form({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const { next } = await searchParams;
  return <LoginForm next={typeof next === "string" ? next : undefined} />;
}
