/**
 * What each role may do — asserted, not assumed.
 *
 *   pnpm test
 *
 * The companion to isolation.test.ts. That one proves a workspace cannot reach
 * another's rows; this one proves a *member* of a workspace cannot do more than
 * their role allows. Both exist for the same reason: the check is centralised
 * (`requireRole` → Better Auth's access control), so the thing worth testing is
 * the table it consults, once, rather than every action that consults it.
 *
 * These call the roles directly rather than over HTTP. `requireRole` is a thin
 * wrapper — resolve the workspace, ask `hasPermission`, throw — and what can
 * actually be got wrong is the statement/role wiring below it: a capability
 * granted to a role that shouldn't have it reads exactly like one that should.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { editor, isRole, owner, ROLES, viewer } from "../lib/server/auth/roles";

const roles = { owner, editor, viewer };

/** Every capability any role could ask for, and who is supposed to get it. */
const matrix = [
  // capability                          owner  editor viewer
  ["enrichment", ["update"], true, true, false],
  ["budget", ["update"], true, true, false],
  ["sync", ["run"], true, true, false],
  ["bankLink", ["create"], true, false, false],
  ["bankLink", ["revoke"], true, false, false],
  ["member", ["create"], true, false, false],
  ["member", ["delete"], true, false, false],
  ["invitation", ["create"], true, false, false],
  ["invitation", ["cancel"], true, false, false],
  ["organization", ["update"], true, false, false],
  ["organization", ["delete"], true, false, false],
] as const;

describe("roles grant exactly what the plan says", () => {
  for (const [resource, actions, forOwner, forEditor, forViewer] of matrix) {
    const expected = { owner: forOwner, editor: forEditor, viewer: forViewer };

    for (const [name, role] of Object.entries(roles)) {
      const want = expected[name as keyof typeof expected];
      test(`${name} ${want ? "may" : "may not"} ${resource}.${actions.join("/")}`, () => {
        const { success } = role.authorize({ [resource]: actions } as never);
        assert.equal(
          success,
          want,
          `${name} ${success ? "can" : "cannot"} ${resource}.${actions.join("/")}, ` +
            `but ${want ? "should be able to" : "should not"}`,
        );
      });
    }
  }
});

describe("the role vocabulary is closed", () => {
  test("a viewer holds no write capability at all", () => {
    // Read is deliberately not a statement — membership is read access, enforced
    // by scopedDb. So a viewer's permission set being *empty* is the design, and
    // this asserts it stays that way rather than quietly gaining a power.
    for (const [resource, actions] of matrix) {
      const { success } = viewer.authorize({ [resource]: actions } as never);
      assert.equal(success, false, `viewer gained ${resource}.${actions.join("/")}`);
    }
  });

  test("only owner/editor/viewer are roles", () => {
    assert.deepEqual([...ROLES], ["owner", "editor", "viewer"]);
    assert.ok(isRole("owner"));
    assert.ok(!isRole("admin"), "Better Auth's stock `admin` is not a role here");
    assert.ok(!isRole("member"), "Better Auth's stock `member` is not a role here");
  });
});
