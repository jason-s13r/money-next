// FormData reading, and Zod-backed parsing for the forms complex enough to want
// a schema.
//
// Two levels, because the actions genuinely have two levels of need:
//
//   - Most actions read one or two fields and check them with a line of code
//     (`if (!name) return { error: "…" }`). They use `raw` / `text` /
//     `optionalId` — the field readers — and keep their own checks. A schema
//     for a single `name` field buys nothing a `!name` does not.
//
//   - The item form (budgets) has nine fields with formats, ranges and an
//     either/or. It uses `parseForm`, which reads every field in a shape and
//     validates them in one pass, returning `{ data }` or a one-line `{ error }`
//     ready to drop into the `{ error: string | null }` state every action
//     returns.
//
// The dividing line is whether the validation is longer than the schema would
// be. Adding `parseForm` to a one-field action would be ceremony, and this file
// does not ask for it.

import { z } from "zod";
import { APIError } from "better-auth/api";

/**
 * Read a `FormData` field as a string, exactly as posted — no trimming.
 *
 * For credentials. A password's leading or trailing space is *part of the
 * password*: the browser posts what the user typed, the hasher must receive it
 * unaltered, and a helper that quietly trims would lock out anyone whose stored
 * hash was computed over the untrimmed bytes. Use this for passwords, tokens
 * and TOTP secrets; use `text` for everything a human typed into a normal field.
 */
export function raw(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * Read a `FormData` field as a trimmed string, or `""` when absent / a `File`.
 *
 * The one helper the hand-rolled `text()` duplicated across budgets and chat
 * was doing — now in one place. Trims, because a name with a trailing space is
 * a typo in every field this is used for. Not for credentials: see `raw`.
 */
export function text(form: FormData, key: string): string {
  return raw(form, key).trim();
}

/** An optional id field: empty string means "not set", not "the empty id". */
export function optionalId(form: FormData, key: string): string | null {
  return text(form, key) || null;
}

/**
 * The result of parsing a form against a schema — either the validated data,
 * or a one-line error string ready for a `{ error }` state.
 */
export type FormResult<T> = { data: T } | { error: string };

/**
 * Parse a `FormData` against a Zod shape.
 *
 * Each field named in the shape is read with `text()` (trimmed string, `""` for
 * absent / `File`), then handed to its schema entry — so entries use
 * `z.string()` as their base and `.refine` / `.transform` on top of it. A form
 * field is a string until the schema says otherwise, which is the same model the
 * hand-rolled code used and keeps the schemas readable next to the inputs they
 * describe.
 *
 * Because every field arrives trimmed, this is not the tool for a password form
 * — see `raw`. No form using it has one.
 *
 * On failure the *first* issue's message is returned. Zod orders issues by the
 * shape's key order, so writing the shape in the order the form reads top to
 * bottom makes the reported error the first thing wrong on the page. Every entry
 * carries its own message for the same reason the hand-rolled ladder did: Zod's
 * defaults ("Invalid option: expected one of …") are the wrong voice for a page
 * a household reads.
 */
export function parseForm<S extends z.ZodRawShape>(
  form: FormData,
  shape: S,
): FormResult<z.output<z.ZodObject<S>>> {
  const input: Record<string, string> = {};
  for (const key of Object.keys(shape)) {
    input[key] = text(form, key);
  }

  const result = z.object(shape).safeParse(input);
  if (result.success) return { data: result.data };
  return { error: result.error.issues[0]?.message || "Check the form and try again." };
}

/**
 * Turn Better Auth's thrown `APIError` into an error string, re-throwing
 * anything else.
 *
 * The repeated `if (error instanceof APIError) return { error: ... }; throw
 * error;` block across six auth actions, factored into one. The `fallback` is
 * the action-specific message ("Could not sign in.", etc.) used when the
 * `APIError` carries none of its own.
 *
 * It throws rather than returning for a non-`APIError`, which is unusual for a
 * function named for what it returns — but it is the behaviour every call site
 * had, and it is the right one: a `TypeError` from our own code is not something
 * to render as "Could not sign in." and move on from.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof APIError) {
    const body = error.body as { message?: string } | undefined;
    return body?.message ?? fallback;
  }
  throw error;
}
