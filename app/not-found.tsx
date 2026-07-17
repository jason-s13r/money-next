import { connection } from "next/server";
import Link from "next/link";

/**
 * This page exists to be *dynamic*, not to be pretty.
 *
 * Without a root not-found, Next prerenders its built-in one at build time —
 * the only static page in the app. A static page is rendered when there is no
 * request, so there is no nonce to stamp on its scripts, and `strict-dynamic`
 * in our CSP makes the browser ignore `'self'` and refuse every one of them.
 * The result is a 404 that renders correctly and is completely inert: no
 * hydration, so no client-side navigation away from it.
 *
 * `await connection()` opts this into dynamic rendering, which is what earns it
 * a nonce. See proxy.ts for the policy, and docs/threat-model.md (T22) for how
 * this exact mistake shipped once already.
 *
 * It is reached for a genuinely unknown URL, and also — deliberately — for a
 * workspace you are not a member of: `requireWorkspace()` calls `notFound()`
 * rather than saying "forbidden", so a non-member cannot tell an existing
 * workspace from an imaginary one.
 */
export default async function NotFound() {
  await connection();

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="text-sm opacity-70">
        That page doesn&rsquo;t exist, or isn&rsquo;t yours to see.
      </p>
      <Link href="/" className="text-sm underline underline-offset-4">
        Go home
      </Link>
    </main>
  );
}
