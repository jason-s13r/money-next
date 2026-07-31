import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";

import { optionalId, parseForm, raw, text } from "../lib/form-data";

/**
 * The field readers every server action's input goes through.
 *
 * Worth testing because the interesting property is a *difference* between two
 * one-line functions. `text` trims and `raw` does not, and the whole reason both
 * exist is that using the wrong one on a password field is silent: the form
 * still submits, the action still runs, and the only symptom is that someone
 * whose password ends in a space can no longer sign in. Nothing about the call
 * site looks wrong, so the guarantee has to be written down here.
 */

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("raw", () => {
  test("returns the value exactly as posted", () => {
    assert.equal(raw(form({ password: "  hunter2  " }), "password"), "  hunter2  ");
  });

  test("preserves a password that is nothing but whitespace", () => {
    // Not a password anyone should choose, but if it is the one on the account
    // it is the one that has to reach the verifier.
    assert.equal(raw(form({ password: "    " }), "password"), "    ");
  });

  test("is the empty string for an absent field", () => {
    assert.equal(raw(form({}), "password"), "");
  });

  test("is the empty string for a File, not '[object File]'", () => {
    const data = new FormData();
    data.append("password", new File([], "x.txt"));
    assert.equal(raw(data, "password"), "");
  });
});

describe("text", () => {
  test("trims", () => {
    assert.equal(text(form({ name: "  Weekly shop  " }), "name"), "Weekly shop");
  });

  test("collapses a whitespace-only field to empty, so `!name` catches it", () => {
    assert.equal(text(form({ name: "   " }), "name"), "");
  });

  test("differs from raw only by the trim", () => {
    const data = form({ field: " padded " });
    assert.equal(text(data, "field"), raw(data, "field").trim());
  });
});

describe("optionalId", () => {
  test("an unset select is null, not the empty id", () => {
    assert.equal(optionalId(form({ categoryId: "" }), "categoryId"), null);
  });

  test("a set one passes through", () => {
    assert.equal(optionalId(form({ categoryId: "cat_1" }), "categoryId"), "cat_1");
  });
});

describe("parseForm", () => {
  const shape = {
    name: z.string().min(1, "Give the item a name."),
    amount: z
      .string()
      .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0, "Enter an amount greater than zero.")
      .transform(Number),
  };

  test("returns the transformed data on success", () => {
    const result = parseForm(form({ name: " Rent ", amount: "450" }), shape);
    assert.deepEqual(result, { data: { name: "Rent", amount: 450 } });
  });

  test("returns the schema's own message, not Zod's default", () => {
    const result = parseForm(form({ name: "Rent", amount: "nope" }), shape);
    assert.deepEqual(result, { error: "Enter an amount greater than zero." });
  });

  test("reports the first field in shape order, so the page's top error wins", () => {
    // Both are wrong; `name` is written first in the shape because it is first on
    // the page, and that is the one the reader should be sent to.
    const result = parseForm(form({ name: "", amount: "nope" }), shape);
    assert.deepEqual(result, { error: "Give the item a name." });
  });

  test("an absent field is an empty string, not undefined", () => {
    // The distinction matters: `z.string()` rejects `undefined` with "Required",
    // which is Zod's voice. Reading through `text` means the schema's own
    // `.min(1, "…")` message is what a missing field produces.
    const result = parseForm(form({ amount: "5" }), shape);
    assert.deepEqual(result, { error: "Give the item a name." });
  });
});
