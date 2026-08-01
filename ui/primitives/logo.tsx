import { cn } from "@/lib/utils";

/**
 * A merchant or institution logo, as supplied by Akahu.
 *
 * Every logo in the app is this: a small square mark sitting next to a name, at
 * one of a handful of sizes. Collecting them here is mostly about the `<img>`
 * below being a deliberate choice rather than an oversight, made in one place
 * instead of ten.
 *
 * **Why not `next/image`.** `@next/next/no-img-element` wants one, and for a
 * content image it would be right. These are 16–32px chrome:
 *
 * - None of them is ever the LCP element, so the rule's stated benefit doesn't
 *   apply. They're already small files on a CDN.
 * - `next/image` routes them through Next's optimizer, which fetches each URL
 *   *server-side* and needs `sharp` in the runtime image. That's a real change
 *   to both the deployment (`output: "standalone"` would have to trace sharp,
 *   which `pnpm-workspace.yaml` currently lists under `ignoredBuiltDependencies`)
 *   and the threat model — proxy.ts's `img-src` allowlist is built on the
 *   browser being the one to fetch `cdn.akahu.nz` (see the T22 note there).
 *
 * If that trade ever flips, this is the single file to change.
 *
 * `src` is nullable because most callers get it straight off a row where the
 * field is optional; a missing logo renders nothing rather than a broken frame,
 * which is what every call site used to spell out with its own ternary.
 *
 * `alt` is empty on purpose: the logo always sits beside the name it belongs to,
 * so announcing it would just repeat that to a screen reader.
 */
export function Logo({
  src,
  className,
}: {
  src: string | null | undefined;
  className?: string;
}) {
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see the note above.
    <img
      src={src}
      alt=""
      loading="lazy"
      className={cn("rounded object-contain", className)}
    />
  );
}
