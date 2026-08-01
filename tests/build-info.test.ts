import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, describe, test } from "node:test";

import { buildInfo } from "../lib/server/build-info";

/**
 * How the deployed build identifies itself.
 *
 * Worth testing rather than eyeballing because the failure mode is silent and
 * actively misleading: a stamp that reads `a1b2c3d` when the running image was
 * built from a dirty tree, or that keeps reporting a stale commit, is worse than
 * no stamp at all — the whole point of the line is to be trusted when you're
 * asking "did that deploy actually land?".
 */

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

/**
 * Set the vars the runner image carries, as install.sh would. `NODE_ENV` is
 * typed as a fixed union by @types/node, hence the cast on the way in — the
 * whole object is being swapped, not the property assigned.
 */
function stamp(env: {
  APP_GIT_SHA?: string;
  APP_BUILT_AT?: string;
  APP_GIT_REMOTE?: string;
  NODE_ENV?: string;
}) {
  process.env = { ...saved, NODE_ENV: "production", ...env } as NodeJS.ProcessEnv;
}

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

/** One `git config` value, or null when it is unset (git exits non-zero). */
function gitConfig(key: string) {
  try {
    return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The remote URL this checkout's branch resolves to, by the same rule the module
 * uses — `branch.<name>.remote`, or `origin` for a branch that tracks nothing —
 * so the test and the code under test can't disagree about whether there is one.
 * Shelled out to rather than parsed: the module hand-parses `.git/config` only
 * because it runs on a request path, and a test has no such constraint.
 */
function trackedRemoteUrl() {
  const branch = (() => {
    try {
      return execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        encoding: "utf8",
      }).trim();
    } catch {
      return null; // detached HEAD, which falls back to origin just as the module does
    }
  })();
  const remote = (branch && gitConfig(`branch.${branch}.remote`)) || "origin";
  return gitConfig(`remote.${remote}.url`);
}

describe("buildInfo", () => {
  test("reports the stamped commit, abbreviated for display", () => {
    stamp({
      APP_GIT_SHA: SHA,
      APP_BUILT_AT: "2026-07-24T02:30:00Z",
      APP_GIT_REMOTE: "git@github.com:owner/repo.git",
    });
    const build = buildInfo();

    assert.equal(build.sha, SHA);
    assert.equal(build.short, "a1b2c3d");
    assert.equal(build.commitUrl, `https://github.com/owner/repo/commit/${SHA}`);
    assert.equal(build.dirty, false);
    assert.equal(build.builtAt, "2026-07-24T02:30:00Z");
    assert.equal(build.mode, "production");
  });

  // The mode is carried raw and it is the sidebar that stays quiet about
  // production — so what this asserts is that a non-production run is
  // distinguishable at all, which is the whole point of surfacing it.
  test("carries the run mode, production included", () => {
    stamp({ NODE_ENV: "development", APP_GIT_SHA: SHA });
    assert.equal(buildInfo().mode, "development");

    stamp({ NODE_ENV: "production", APP_GIT_SHA: SHA });
    assert.equal(buildInfo().mode, "production");
  });

  // The suffix rides on the same var so there is one string to pass to
  // `--build-arg` and one to read back out of `podman inspect`. It must not end
  // up in the sha itself, or the commit won't resolve when someone pastes it.
  test("splits the +dirty marker off the sha", () => {
    stamp({ APP_GIT_SHA: `${SHA}+dirty` });
    const build = buildInfo();

    assert.equal(build.sha, SHA);
    assert.equal(build.short, "a1b2c3d");
    assert.equal(build.dirty, true);
  });

  // An image built by hand (`podman build` with no --build-arg) gets the
  // Dockerfile's empty default; `unknown` is what install.sh would pass if the
  // repo had no git. Both mean the same thing and must not render as a version.
  test("an unstamped production image knows it is unknown", () => {
    for (const APP_GIT_SHA of ["", "   ", "unknown"]) {
      stamp({ APP_GIT_SHA });
      const build = buildInfo();

      assert.equal(build.sha, null);
      assert.equal(build.short, null);
      assert.equal(build.dirty, false);
      assert.equal(build.builtAt, null);
      assert.equal(build.commitUrl, null);
    }
  });

  // Outside a container there are no env vars, so the stamp falls back to
  // reading .git — otherwise the line would be permanently "unknown" in dev and
  // nobody would notice it had broken in prod either.
  test("falls back to the working tree's HEAD in development", () => {
    stamp({ NODE_ENV: "development" });
    const build = buildInfo();

    assert.match(build.sha ?? "", /^[0-9a-f]{40}$/);
    assert.equal(build.short, build.sha?.slice(0, 7));
    // The file read can't tell whether the tree is clean; only install.sh can.
    assert.equal(build.dirty, false);
    assert.equal(build.builtAt, null);
  });

  // Same fallback, one field over: the link in dev comes from .git/config, which
  // is the branch's own remote. Asserted by shape rather than by value, because it
  // is *this* checkout's remote — naming a repository here would be asserting who
  // cloned it, and a fork, a rename or an ssh-vs-https clone must all still
  // produce a link. Both directions of the contract are checked, because "no
  // remote" is a real state a checkout can be in (a `git init` that was never
  // pushed) and null is the documented answer for it, not a bug.
  test("derives the commit link from the working tree's remote in development", () => {
    stamp({ NODE_ENV: "development" });
    const build = buildInfo();

    if (!trackedRemoteUrl()) {
      assert.equal(build.commitUrl, null);
      return;
    }

    assert.match(build.commitUrl ?? "", /^https:\/\/[^/]+\/[^/]+\/[^/]+\/commit\/[0-9a-f]{40}$/);
    assert.ok(build.commitUrl?.endsWith(`/commit/${build.sha}`));
  });
});

/**
 * The link under the sha. It exists so a deploy stamp can be clicked through to
 * the code that's running, and it is derived from the remote precisely so that a
 * fork, a rename, or a move to another forge keeps working — a hard-coded
 * repository would quietly point at someone else's commits.
 */
describe("the commit link", () => {
  const url = (remote: string, sha = SHA) => {
    stamp({ APP_GIT_SHA: sha, APP_GIT_REMOTE: remote });
    return buildInfo().commitUrl;
  };
  const commit = `commit/${SHA}`;

  // The same repository is spelled four ways depending on how it was cloned, and
  // all four have to land on the same page.
  test("resolves every spelling of a remote to the same web URL", () => {
    const expected = `https://github.com/owner/repo/${commit}`;

    assert.equal(url("git@github.com:owner/repo.git"), expected);
    assert.equal(url("ssh://git@github.com/owner/repo.git"), expected);
    assert.equal(url("https://github.com/owner/repo.git"), expected);
    assert.equal(url("https://github.com/owner/repo"), expected);
  });

  // Nothing here knows what GitHub is: a self-hosted forge on its own host, and
  // a repo nested in subgroups, are the same two substitutions.
  test("keeps the host and the full repository path of the remote", () => {
    assert.equal(
      url("git@git.example.com:group/sub/repo.git"),
      `https://git.example.com/group/sub/repo/${commit}`,
    );
    assert.equal(
      url("https://git.example.com:8443/group/repo.git"),
      `https://git.example.com:8443/group/repo/${commit}`,
    );
  });

  // An ssh port is the ssh daemon's, not the web UI's — carrying it over would
  // produce a link to a port that doesn't speak HTTP.
  test("drops the port of an ssh remote", () => {
    assert.equal(
      url("ssh://git@git.example.com:2222/owner/repo.git"),
      `https://git.example.com/owner/repo/${commit}`,
    );
  });

  // A remote can carry a token in its userinfo. That must not end up in an href
  // sitting in the DOM of every page.
  test("strips credentials embedded in the remote", () => {
    assert.equal(
      url("https://user:ghp_secret@github.com/owner/repo.git"),
      `https://github.com/owner/repo/${commit}`,
    );
  });

  // No remote to derive from, or nothing web-addressable at the end of it: the
  // sidebar renders plain text rather than a link that goes nowhere.
  test("declines to invent a link it cannot derive", () => {
    const unlinkable = ["", "   ", "/srv/git/repo.git", "file:///srv/git/repo.git", "../sibling-repo"];
    for (const remote of unlinkable) {
      assert.equal(url(remote), null);
    }
    stamp({ APP_GIT_REMOTE: "git@github.com:owner/repo.git" });
    assert.equal(buildInfo().commitUrl, null, "a remote with no sha points at no commit");
  });

  // The sha is interpolated into a path and arrives from the environment, so it
  // has to look like a sha first — and `+dirty` has already been split off it.
  test("only links a sha-shaped commit", () => {
    assert.equal(url("git@github.com:owner/repo.git", "../../etc"), null);
    assert.equal(
      url("git@github.com:owner/repo.git", `${SHA}+dirty`),
      `https://github.com/owner/repo/${commit}`,
    );
  });
});
