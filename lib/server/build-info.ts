// No `import "server-only"`: tests/build-info.test.ts imports this from plain
// Node, the same reason fx.ts next door omits it. The guard would be redundant
// anyway — `node:fs` and `process.env` are what actually keep this off the
// client, and the sidebar only ever imports the *type*, which compiles away.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which build of the app is running — the answer to "is the thing I just
 * deployed actually the thing that's serving?".
 *
 * The values arrive as plain runtime environment variables, stamped into the
 * *runner* image by `deploy/quadlet/install.sh` (`podman build --build-arg`).
 * Deliberately not `NEXT_PUBLIC_*` inlined at build time: the ARGs live in the
 * last Dockerfile stage, so a new commit sha doesn't invalidate the cached
 * `next build` layer, and the value is read per request instead of baked into
 * the client bundle.
 *
 * Nothing here is a secret — the commit of a self-hosted app is only useful to
 * the person running it — but it is still only ever rendered behind a session,
 * never on the login page.
 */
export type BuildInfo = {
  /** Full commit sha, for the tooltip. Null when the image wasn't stamped. */
  sha: string | null;
  /** First seven of `sha`, which is what actually gets displayed. */
  short: string | null;
  /** The tree had uncommitted changes when the image was built. */
  dirty: boolean;
  /** ISO-8601 instant of the build, or null outside a stamped image. */
  builtAt: string | null;
  /**
   * `NODE_ENV`, which is the build mode as well as the run mode: Next forces it
   * to `production` for both `next build` and `next start`, and the runner image
   * sets it explicitly. Raw here; it is the *display* that stays quiet about
   * production (see ui/chrome/build-stamp).
   */
  mode: string;
};

/** Absent, blank and placeholder values collapse to null: one "unknown" case. */
function clean(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "unknown" ? trimmed : null;
}

/**
 * The commit `next dev` is running, read straight out of `.git` so the stamp is
 * useful before anything is containerised. Two small file reads on a path that
 * only runs in development — the deployed image has no `.git` and doesn't need
 * one, it has the env vars. Detached HEAD (a raw sha) is handled by the first
 * branch; anything unreadable is simply "unknown".
 */
function shaFromGit() {
  try {
    const gitDir = join(process.cwd(), ".git");
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    return readFileSync(join(gitDir, head.slice(5)), "utf8").trim();
  } catch {
    return null;
  }
}

export function buildInfo(): BuildInfo {
  // Next always sets this; the fallback is for the plain-Node importers (tests).
  const mode = process.env.NODE_ENV ?? "development";
  // `+dirty` is appended by install.sh rather than carried as its own arg, so
  // there is one string to pass around and one to eyeball in `podman inspect`.
  const [stamped, ...flags] = (clean(process.env.APP_GIT_SHA) ?? "").split("+");
  // The dev fallback can't say whether the tree is dirty (that needs a real
  // `git status`, not a file read), so it only ever reports the commit.
  const sha = stamped || (mode === "production" ? null : shaFromGit());

  return {
    sha,
    short: sha?.slice(0, 7) ?? null,
    dirty: flags.includes("dirty"),
    builtAt: clean(process.env.APP_BUILT_AT),
    mode,
  };
}
