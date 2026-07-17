import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

/**
 * There is no "sign up" link, and that is the design rather than an omission:
 * registration is invite-only (docs/multi-user.md), so an account is only ever
 * born from an invite link or the bootstrap script. There is no open signup path
 * to disable later, and no signup form for anyone to find.
 */
export default async function LoginPage(props: PageProps<"/login">) {
  const { next } = await props.searchParams;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-lg font-semibold">Money</h1>
      <p className="mt-1 text-sm opacity-70">Sign in to continue.</p>
      <LoginForm next={typeof next === "string" ? next : undefined} />
    </main>
  );
}
