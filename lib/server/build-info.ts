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
  /**
   * Where to read this commit on the forge, derived from the remote the build
   * came from — never a hard-coded repository. Null when there is no remote, the
   * remote isn't web-addressable, or there is no sha to point at.
   */
  commitUrl: string | null;
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

/** One file under `.git`, or null for anything unreadable. */
function readGit(path: string) {
  try {
    return readFileSync(join(process.cwd(), ".git", path), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * The commit a ref points at. A ref lives in a file of its own until git decides
 * to pack it — `git gc`, and every fresh `git clone`, move it into `packed-refs`
 * and delete the file — so reading only the loose path finds nothing on a
 * just-cloned checkout, which is precisely the state a new contributor is in.
 *
 * `packed-refs` is `<sha> <refname>` a line, with an optional leading `#` header
 * and `^<sha>` peel lines for tags. Neither of those can match a `refs/heads/`
 * lookup, so a plain suffix comparison is enough.
 */
function readRef(ref: string) {
  const loose = readGit(ref);
  if (loose) return loose;

  const packed = readGit("packed-refs");
  if (!packed) return null;
  for (const line of packed.split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref) return sha;
  }
  return null;
}

/**
 * The commit and remote `next dev` is running against, read straight out of
 * `.git` so the stamp is useful before anything is containerised. A handful of
 * small file reads on a path that only runs in development — the deployed image
 * has no `.git` and doesn't need one, it has the env vars.
 *
 * Detached HEAD (a raw sha) is handled by the first branch, and leaves no branch
 * name to look a remote up by, so that case falls back to `origin` below.
 */
function fromWorkingTree() {
  const head = readGit("HEAD");
  if (!head) return { sha: null, remote: null };
  if (!head.startsWith("ref: ")) return { sha: head, remote: remoteFromConfig(null) };

  const ref = head.slice(5).trim();
  return {
    sha: readRef(ref),
    remote: remoteFromConfig(ref.replace(/^refs\/heads\//, "")),
  };
}

/**
 * The push/fetch URL of the remote this branch tracks — `branch.<name>.remote`,
 * which is what "where does this branch come from" actually means, and `origin`
 * only as the fallback for a branch that tracks nothing.
 *
 * Parsed here rather than shelled out to `git config`, because this module is
 * imported by the server on a request path and spawning a process per render to
 * read a file that never changes would be the wrong trade. `.git/config` is INI:
 * `[remote "origin"]` becomes the key prefix `remote.origin`, exactly the name
 * `git config` itself uses.
 */
function remoteFromConfig(branch: string | null) {
  const config = readGit("config");
  if (!config) return null;

  const values = new Map<string, string>();
  let section = "";
  for (const line of config.split("\n")) {
    const trimmed = line.trim();
    const header = /^\[(.+)]$/.exec(trimmed);
    if (header) {
      section = header[1].replaceAll('"', "").trim().replace(/\s+/, ".");
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (!section || eq < 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    values.set(`${section}.${trimmed.slice(0, eq).trim()}`, trimmed.slice(eq + 1).trim());
  }

  const remote = (branch && values.get(`branch.${branch}.remote`)) || "origin";
  return values.get(`remote.${remote}.url`) ?? null;
}

/**
 * A git remote as its forge's web address for one commit.
 *
 * The remote is the only input, so the link follows the repository the build
 * actually came from — a fork, a rename or a move to another host all point
 * where they should without anything here being changed. Both remote spellings
 * resolve to the same page: the scp-like `git@host:owner/repo.git` and the URL
 * forms (`https://`, `ssh://`, `git://`).
 *
 * `/<owner>/<repo>/commit/<sha>` is the convention GitHub, GitLab, Gitea and
 * Codeberg share; a forge that spells it differently gets a 404 rather than a
 * wrong page, which is the better failure of the two.
 */
function commitUrl(remote: string | null, sha: string | null) {
  // A sha is pasted straight into a path, and in production it arrives from the
  // environment — so it has to look like a sha before it can be part of a URL.
  if (!remote || !sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;

  // `[user@]host:path`, git's own shorthand. Ruled out for anything with a
  // scheme, and for `C:\...`-style paths, which are local and not linkable.
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(remote);
  const [host, path] = scp
    ? [scp[1], scp[2]]
    : (() => {
        try {
          const url = new URL(remote);
          // ssh:// and git:// ports say nothing about where the web UI listens,
          // so only an http(s) remote keeps its port. Credentials in a remote
          // (a token in the URL) are dropped with the rest of the userinfo.
          const web = url.protocol === "http:" || url.protocol === "https:";
          if (!web && url.protocol !== "ssh:" && url.protocol !== "git:") return [null, null];
          return [web ? url.host : url.hostname, url.pathname];
        } catch {
          return [null, null];
        }
      })();

  const repo = path?.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  if (!host || !repo) return null;
  return `https://${host}/${repo}/commit/${sha}`;
}

export function buildInfo(): BuildInfo {
  // Next always sets this; the fallback is for the plain-Node importers (tests).
  const mode = process.env.NODE_ENV ?? "development";
  // `+dirty` is appended by install.sh rather than carried as its own arg, so
  // there is one string to pass around and one to eyeball in `podman inspect`.
  const [stamped, ...flags] = (clean(process.env.APP_GIT_SHA) ?? "").split("+");
  const stampedRemote = clean(process.env.APP_GIT_REMOTE);
  // Read `.git` only for what the environment didn't supply, and never in
  // production: the image has no working tree, and a stamped var is the truth
  // about the running build in a way a file on disk wouldn't be.
  const local =
    mode !== "production" && (!stamped || !stampedRemote)
      ? fromWorkingTree()
      : { sha: null, remote: null };
  // The dev fallback can't say whether the tree is dirty (that needs a real
  // `git status`, not a file read), so it only ever reports the commit.
  const sha = stamped || local.sha;
  const remote = stampedRemote ?? local.remote;

  return {
    sha,
    short: sha?.slice(0, 7) ?? null,
    commitUrl: commitUrl(remote, sha),
    dirty: flags.includes("dirty"),
    builtAt: clean(process.env.APP_BUILT_AT),
    mode,
  };
}
