/**
 * A path on this origin, or null.
 *
 * `?next=` is set by `proxy.ts` and is therefore ours — but it arrives through
 * the URL bar and then through a form field, so it is a stranger's until proven
 * otherwise. Anything that is not a plain absolute path is discarded:
 * `//evil.example` is protocol-relative and would leave the site, and a full URL
 * obviously would.
 *
 * This is the whole of the open-redirect defence, and it lives server-side —
 * where the redirect is actually issued — rather than in the form component that
 * used to own it. A check in the browser is a courtesy; the caller decides what
 * to POST.
 */
export function safeNext(next: unknown): string | null {
  if (typeof next !== "string" || !next) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}
