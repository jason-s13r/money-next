// URLs are addressable, so they are part of the interface: `/categories/food` is
// worth more than `/categories/nzfcc_ckouvvy84001608ml5p6z4d8j`.
//
// A slug is lossy, so it is never the identity of anything. Every route that
// takes one resolves it back to the real name by scanning the values it could
// have come from, and 404s when nothing matches. That keeps the ids out of the
// url without letting a slug become a second, drifting source of truth.

/** Lowercase, runs of non-alphanumerics collapsed to a single hyphen. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The one name in `names` whose slug is `slug`, or null.
 *
 * Two names can slug the same way ("Kamo Vets" and "Kamo-Vets" would), and the
 * caller cannot tell which was meant. Returning null rather than the first match
 * turns a silent wrong answer into a 404.
 */
export function fromSlug(names: string[], slug: string): string | null {
  const matches = names.filter((name) => slugify(name) === slug);
  return matches.length === 1 ? matches[0] : null;
}
