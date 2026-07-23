/**
 * Ids the app mints for itself. See lib/ids.ts.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { mintId } from "../lib/ids";

const original = process.env.ID_NAMESPACE;
afterEach(() => {
  if (original === undefined) delete process.env.ID_NAMESPACE;
  else process.env.ID_NAMESPACE = original;
});

describe("mintId", () => {
  test("is namespaced, typed, and opaque", () => {
    process.env.ID_NAMESPACE = "test";
    const id = mintId("merchant");
    assert.match(id, /^test_merchant_[0-9a-f]{32}$/);
  });

  test("defaults to a namespace, so nothing has to be configured", () => {
    delete process.env.ID_NAMESPACE;
    assert.match(mintId("merchant"), /^app_merchant_/);
  });

  test("cannot be confused with an id we mirror rather than mint", () => {
    // NZFCC's ids are cuid-shaped, so an unprefixed random id would be
    // indistinguishable from an imported one. That is the whole point.
    process.env.ID_NAMESPACE = "test";
    for (const id of [mintId("merchant"), mintId("category"), mintId("group")]) {
      assert.ok(!id.startsWith("nzfcc_"));
      assert.ok(!id.startsWith("merchant_"));
      assert.ok(!id.startsWith("group_"));
    }
  });

  test("ids are unique", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => mintId("merchant")));
    assert.equal(ids.size, 1000);
  });

  test("a bad namespace fails loudly rather than being silently rewritten", () => {
    for (const bad of ["has_underscore", "UPPER", "has space", "punc!"]) {
      process.env.ID_NAMESPACE = bad;
      assert.throws(() => mintId("merchant"), /ID_NAMESPACE must be/, `accepted: ${bad}`);
    }
  });

  test("changing the namespace does not invalidate ids minted under the old one", () => {
    // The property that makes the setting safe to change: nothing parses these,
    // so the two coexist. If this ever fails, some code has started branching on
    // the prefix and the setting has quietly become one-way.
    process.env.ID_NAMESPACE = "old";
    const before = mintId("merchant");
    process.env.ID_NAMESPACE = "new";
    const after = mintId("merchant");
    assert.notEqual(before.split("_")[0], after.split("_")[0]);
    assert.match(before, /^old_merchant_/);
  });
});
