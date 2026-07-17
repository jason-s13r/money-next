"use client";

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
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const forbidden = error.digest === "FORBIDDEN";

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-lg font-semibold">
        {forbidden ? "You can't change that" : "Something went wrong"}
      </h1>

      <p className="mt-2 text-sm text-muted">
        {forbidden
          ? "Your role in this workspace is view-only. You can read everything here, but not edit it — ask an owner if you need to."
          : "That didn't work, and the details were logged. Trying again is safe."}
      </p>

      {/* Not offered for a refusal: the answer would be the same every time, and
          a retry button that cannot succeed is the same lie as the dropdown that
          started this. */}
      {forbidden ? null : (
        <button
          type="button"
          onClick={reset}
          className="mt-4 self-start rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background"
        >
          Try again
        </button>
      )}

      {/* The digest is what a log search takes; ours is a marker, not an id. */}
      {error.digest && !forbidden ? (
        <p className="mt-6 font-mono text-xs text-muted">{error.digest}</p>
      ) : null}
    </main>
  );
}
