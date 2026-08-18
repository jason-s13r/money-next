import { randomUUID } from "node:crypto";

/**
 * Turning what a workspace is called into what its URL says.
 *
 * No database access: collision handling takes the "is this taken?" check as a
 * parameter, which is what makes the retry path testable rather than a branch
 * that only fires in production and has therefore never run.
 */

/**
 * A default name for someone's first workspace: "Sam's Personal".
 *
 * A *suggestion*, computed once at creation and never re-derived — so it cannot
 * go stale when ownership moves, which it can (the last-owner invariant
 * guarantees *an* owner, not the one who created it).
 *
 * The first-token heuristic will get some names wrong. It costs one `--name` to
 * override, and would not be acceptable anywhere the app displayed it unasked.
 */
export function suggestName(ownerName: string): string {
  const first = ownerName.trim().split(/\s+/)[0] ?? ownerName;
  return `${first}'s Personal`;
}

/**
 * A name, as a URL segment. Possessives are stripped rather than transliterated,
 * which is why this is not a one-line regex: "Sam's Personal" is `sam-personal`,
 * not `sam-s-personal` or `sams-personal`. Remaining apostrophes are deleted,
 * not separated — "O'Brien" is `obrien`, one word, because that is how it is said.
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
 * `slugify` returns nothing for a name in a non-Latin script or one made only of
 * punctuation. That is not an error: the operator named the *workspace*, not the
 * URL. So it falls back to `suggestName`, which cannot itself be empty — the
 * template ends in the literal "Personal", so that word always survives. 山田太郎
 * (Yamada Tarō, the Japanese "John Doe") gets `personal`; Sam gets `sam-personal`.
 * No third rung, because none is reachable.
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
 * The first free slug for this name: `personal`, else `personal-a3f9`. The
 * suffix appears only where it is earned, so it means something when it does.
 *
 * Not a uniqueness guarantee — check-then-insert is not atomic however many
 * times it is retried. `Workspace.slug @unique` is the guarantee; this only
 * decides which candidate to offer first.
 *
 * A fixed four hex characters rather than a length that grows until it fits: a
 * branch needing ~65k same-named workspaces to fire is one that will never have
 * run when it matters.
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
