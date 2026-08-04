/**
 * `pnpm help:commands` against package.json.
 *
 * A help screen is only worth having if it is complete, and the way it stops
 * being complete is silent: someone adds a script, never runs the help, and the
 * new command is missing from the one place people look. Nothing in the code
 * connects the two lists, so an inventory check does — the same idiom as the
 * unscoped-client allowlist in isolation.test.ts.
 *
 * (Naming that client here would trip its own fence, which greps for the
 * identifier and does not care that this file only talks about it.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { DESCRIPTIONS, GROUPS, HIDDEN } from "../scripts/help";

const { scripts } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

const listed = Object.keys(scripts).filter((name) => !HIDDEN.has(name));

describe("pnpm help:commands", () => {
  test("every command has a description", () => {
    const undescribed = listed.filter((name) => !DESCRIPTIONS[name]);

    assert.deepEqual(
      undescribed,
      [],
      `these scripts are in package.json with no line in scripts/help.ts: ` +
        `${undescribed.join(", ")}. Add one there, or add the name to HIDDEN if it ` +
        `is not something a person runs.`,
    );
  });

  test("no description outlives the command it describes", () => {
    // The other direction, and the one that survives a rename: `db:sync` becomes
    // `worker:sync`, the old line stays, and the help now documents a command that
    // is not there.
    const known = new Set([...listed, ...HIDDEN]);
    const orphaned = Object.keys(DESCRIPTIONS).filter((name) => !known.has(name));

    assert.deepEqual(
      orphaned,
      [],
      `scripts/help.ts describes commands that package.json does not have: ${orphaned.join(", ")}.`,
    );
  });

  test("the deprecated aliases are hidden, not forgotten", () => {
    // They must keep working — that is their whole purpose — while staying out of
    // the list, which would otherwise advertise the spelling being retired.
    for (const alias of ["db:sync", "db:worker"]) {
      assert.ok(scripts[alias], `${alias} was removed; drop it from HIDDEN too.`);
      assert.ok(HIDDEN.has(alias), `${alias} would be listed in the help.`);
      assert.match(scripts[alias], /DEPRECATED/);
    }
  });

  test("every group title is used", () => {
    // A group whose prefix no longer matches anything prints nothing, so an empty
    // one is invisible rather than wrong — but it is still a rename nobody
    // finished.
    const prefixes = new Set(
      listed.map((name) => (name.includes(":") ? name.slice(0, name.indexOf(":")) : "")),
    );
    const unused = GROUPS.filter((group) => !prefixes.has(group.prefix)).map((group) => group.title);

    assert.deepEqual(unused, [], `these groups in scripts/help.ts match no command: ${unused.join(", ")}.`);
  });
});
