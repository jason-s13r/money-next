"use client";

import { Link } from "@/ui/chrome/workspace-context";

/**
 * The backstop for anything a workspace page throws.
 *
 * The app had none until phase 4, which held for as long as every user was an
 * owner: nothing refused anybody, so nothing needed catching. The first viewer
 * clicked a merchant dropdown and got an unhandled `ForbiddenError` — a 500 in
 * the log and an uncaught error in the browser, for a permission check working
 * exactly as designed. The gate was right; there was just nothing between it and
 * the person.
 *
 * The controls a viewer cannot use are hidden now (see `useCanEdit`), so this
 * should be unreachable by that route. It stays anyway, and that is the point:
 * hiding a button is a rendering decision made in one place by someone who might
 * forget, while this catches the one that was forgotten. The next role, the next
 * action, the race where permission is revoked between render and click — all of
 * them land here rather than on a stack trace.
 *
 * Matched on `digest`, not on `instanceof` or the message. The error crossed the
 * server boundary, so the class is gone by the time this renders, and in
 * production Next strips `message` too — so a check against the text would work
 * in development, pass review, and quietly fall through to "something went
 * wrong" for every real user. `ForbiddenError` carries `digest: "FORBIDDEN"`
 * precisely because that is the one field that survives.
 */

/**
 * The errors we can say something true about, keyed by the digest each one
 * chose for itself. Anything not here is a genuine fault and gets the generic
 * copy — this table is for conditions the *person* can act on, or at least
 * understand, not for dressing up bugs.
 *
 * `retry: false` on both, and for the same reason: a "try again" button that
 * cannot succeed is the same lie as the dropdown a viewer isn't allowed to use.
 * A refusal will refuse again, and a workspace with no bank will still have no
 * bank until somebody with shell access connects one.
 */
type Known = {
  title: string;
  body: string;
  retry: boolean;
  /** Where to go instead of retrying, when there is somewhere useful. */
  link?: { href: string; label: string };
};

const KNOWN: Record<string, Known> = {
  FORBIDDEN: {
    title: "You can't change that",
    body:
      "Your role in this workspace is view-only. You can read everything here, " +
      "but not edit it — ask an owner if you need to.",
    retry: false,
  },
  NO_BANK_LINK: {
    title: "No bank connected",
    body:
      "This workspace has no bank connection yet, so there's nothing to sync. " +
      "An owner can connect one on the sync page; everyone else will need to ask them to.",
    retry: false,
    // Not a plain <a>: the form lives inside the workspace, and every href in
    // this app carries the slug (see ui/chrome/workspace-context). The boundary
    // renders inside the provider, so the scoped Link works here.
    link: { href: "/sync", label: "Go to sync" },
  },
};

const GENERIC: Known = {
  title: "Something went wrong",
  body: "That didn't work, and the details were logged. Trying again is safe.",
  retry: true,
};

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const known = error.digest ? KNOWN[error.digest] : undefined;
  const { title, body, retry, link } = known ?? GENERIC;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-lg font-semibold">{title}</h1>

      <p className="mt-2 text-sm text-muted">{body}</p>

      {retry ? (
        <button
          type="button"
          onClick={reset}
          className="mt-4 self-start rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          Try again
        </button>
      ) : null}

      {link ? (
        <Link
          href={link.href}
          className="mt-4 self-start rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          {link.label}
        </Link>
      ) : null}

      {/* The digest is what a log search takes — but only for the faults, where
          it identifies one occurrence. Ours are markers, not ids: printing
          "NO_BANK_LINK" under a sentence that already explains it adds nothing
          but noise. */}
      {error.digest && !known ? (
        <p className="mt-6 font-mono text-xs text-muted">{error.digest}</p>
      ) : null}
    </main>
  );
}
