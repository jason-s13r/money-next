import { randomUUID } from "node:crypto";

/**
 * Turning what a workspace is called into what its URL says.
 *
 * Its own module, and not part of `create-workspace.ts`, for one practical
 * reason: that script calls `main()` at the top level, so a test importing it
 * would *run* it. The rules below are the part with edge cases worth testing —
 * possessives, collisions, the suffix — so they live somewhere a test can reach
 * without side effects.
 *
 * No database access here. Collision handling takes the "is this taken?" check
 * as a parameter, which is what makes the retry path testable rather than being
 * a branch that only fires in production and has therefore never run.
 */

/**
 * A default name for someone's first workspace: "Sam's Personal".
 *
 * A *suggestion*, and that word is doing real work. Encoding the owner into the
 * workspace's identity structurally would be wrong, because ownership moves —
 * `changeRole` and `removeMember` exist, and the last-owner invariant guarantees
 * *an* owner, not *the* one who created it. A slug derived from ownership would
 * become false the first time a workspace changed hands, and with no rename
 * surface it would stay false.
 *
 * Offering it as a default sidesteps that entirely: it is computed once, at
 * creation, from whatever the operator accepted. Nothing re-derives it and
 * nothing checks it, so it cannot go stale — it is a name a human chose, which
 * happens to have been typed for them.
 *
 * The first-token heuristic is exactly that. Not every name is "given family",
 * and this will get some of them wrong; it is a default in a CLI that also
 * accepts `--name`, so being wrong costs one flag. It would not be acceptable as
 * anything the app displayed on its own authority.
 */
export function suggestName(ownerName: string): string {
  const first = ownerName.trim().split(/\s+/)[0] ?? ownerName;
  return `${first}'s Personal`;
}

/**
 * A name, as a URL segment.
 *
 * Possessives are stripped rather than transliterated, which is the whole reason
 * this is not a one-line regex: "Sam's Personal" should be `sam-personal`.
 * Replacing punctuation with a separator gives `sam-s-personal`, and merely
 * deleting the apostrophe gives `sams-personal` — both are what you get by not
 * thinking about it, and both read as a typo forever, since there is no rename.
 *
 * Remaining apostrophes are deleted, not separated: "O'Brien" is `obrien`, one
 * word, because that is how it is said.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The base a workspace's slug is built from, before disambiguation.
 *
 * `slugify` can return nothing at all — a name written in a non-Latin script, or
 * one made only of punctuation, has no ASCII to keep. That is not an error and
 * must not be treated as one: the operator named the *workspace*, not the URL,
 * so failing them with "not usable as a URL segment" complains about a string
 * they never typed.
 *
 * So it falls back to the same phrasing the default name uses. The second rung
 * cannot itself be empty, and it is worth seeing why rather than trusting it:
 * `suggestName` is a template ending in the literal "Personal", so whatever the
 * owner is called, at least that word survives. A person named 山田太郎 (Yamada
 * Tarō — the Japanese equivalent of "John Doe", and a name with no Latin letters
 * to keep) gets `personal`; a person named Sam gets `sam-personal`. There is no
 * third rung because there is no way to reach one — which is better than writing
 * an unreachable one and believing it works.
 */
export function slugBase(name: string, ownerName: string): string {
  return slugify(name) || slugify(suggestName(ownerName));
}

/**
 * Validated, not sanitised — the same rule `ID_NAMESPACE` follows in lib/ids.ts.
 * Quietly rewriting a slug someone typed means the URL they were told to use is
 * not the URL that exists, and they find that out by getting a 404.
 */
export function assertSlug(slug: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new Error(
      `"${slug}" is not usable as a URL segment. Lowercase letters, digits and ` +
        "single hyphens between them; pass --slug to choose one yourself.",
    );
  }
}

/** Disambiguator, from the same source as `mintId` — see lib/ids.ts. */
function code(length: number): string {
  return randomUUID().replace(/-/g, "").slice(0, length);
}

/**
 * The first free slug for this name: the plain one, else a suffixed one.
 *
 * "Personal" being taken globally by whoever got here first is a real
 * irritation and this is the fix for it — `personal`, then `personal-a3f9`. The
 * suffix appears only where it is earned, so it carries information when it does
 * appear: there was already one of these.
 *
 * Note what this is *not*: a uniqueness guarantee. Check-then-insert is not
 * atomic no matter how many times it is retried, so the guarantee is
 * `Workspace.slug @unique` in Postgres and nothing here. This only decides which
 * candidate to offer the database first, and keeps the common case pretty.
 *
 * Four hex characters, and deliberately not a length that grows until it fits: a
 * loop whose interesting branch needs ~65k same-named workspaces to fire is a
 * branch that will never have run when it matters. A fixed suffix with a bounded
 * number of attempts has the same practical effect and every path is reachable
 * in a test.
 */
export async function chooseSlug(
  base: string,
  isTaken: (slug: string) => Promise<boolean>,
  attempts = 5,
): Promise<string> {
  if (!(await isTaken(base))) return base;

  for (let i = 0; i < attempts; i++) {
    const candidate = `${base}-${code(4)}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  throw new Error(
    `Could not find a free slug for "${base}" after ${attempts} attempts. ` +
      "Pass --slug to choose one.",
  );
}
