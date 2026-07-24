import assert from "node:assert/strict";
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
function stamp(env: { APP_GIT_SHA?: string; APP_BUILT_AT?: string; NODE_ENV?: string }) {
  process.env = { ...saved, NODE_ENV: "production", ...env } as NodeJS.ProcessEnv;
}

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("buildInfo", () => {
  test("reports the stamped commit, abbreviated for display", () => {
    stamp({ APP_GIT_SHA: SHA, APP_BUILT_AT: "2026-07-24T02:30:00Z" });
    const build = buildInfo();

    assert.equal(build.sha, SHA);
    assert.equal(build.short, "a1b2c3d");
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
});
