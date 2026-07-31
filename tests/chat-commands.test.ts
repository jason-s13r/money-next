/**
 * Completing the *argument* of a command, once its name is typed.
 *
 *   pnpm test
 *
 * The name half — `parseCommand` and `commandMenu` — is covered in chat-tools.test.ts,
 * where it has always lived. This is the half after the space, and the property that
 * matters is where one stops and the other starts: `/model qwen` must get the models and
 * not a menu of commands it is no longer choosing between, and `/mod` must get the
 * opposite. Pure, and tested away from a browser for the reason lib/chat/commands.ts
 * gives for being pure — these are the cases nobody types by accident and so nobody
 * notices by hand.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { argumentMenu, commandMenu } from "../lib/chat/commands";

/** A plausible local runtime's list: path-like ids, a couple of near-identical tags. */
const MODELS = [
  "glm-5.2:cloud",
  "hf.co/bartowski/qwen3-14b:Q4_K_M",
  "qwen3:14b",
  "qwen3:32b",
];

describe("argumentMenu", () => {
  test("takes over exactly where the command menu lets go", () => {
    assert.ok(commandMenu("/mod", "idle"), "still a name being typed");
    assert.equal(argumentMenu("/mod", MODELS), null);

    assert.equal(commandMenu("/model ", "idle"), null, "the space hands over");
    assert.ok(argumentMenu("/model ", MODELS));
  });

  test("only for a command that has something to complete", () => {
    assert.equal(argumentMenu("/steer read Food again", MODELS), null);
    assert.equal(argumentMenu("not a command at all", MODELS), null);
  });

  test("offers everything before anything is typed", () => {
    assert.deepEqual(argumentMenu("/model ", MODELS)?.matches, MODELS);
  });

  test("matches any part of a name, and ranks a prefix first", () => {
    // The tail is what people remember of `hf.co/bartowski/qwen3-14b:Q4_K_M`.
    assert.deepEqual(argumentMenu("/model qwen", MODELS)?.matches, [
      "qwen3:14b",
      "qwen3:32b",
      "hf.co/bartowski/qwen3-14b:Q4_K_M",
    ]);
  });

  test("case does not matter, and no match is an empty menu rather than none", () => {
    assert.deepEqual(argumentMenu("/model GLM", MODELS)?.matches, ["glm-5.2:cloud"]);
    assert.deepEqual(argumentMenu("/model llama", MODELS)?.matches, []);
  });

  test("answers the shape of the line even with no values to offer", () => {
    // How the composer asks whether this line is worth fetching a model list for,
    // before it has one.
    assert.deepEqual(argumentMenu("/model ", [])?.matches, []);
    assert.equal(argumentMenu("/compact ", []), null);
  });
});
