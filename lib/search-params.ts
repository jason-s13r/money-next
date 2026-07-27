/**
 * The first value of a Next.js search param, which may be absent or (when the key
 * repeats in the url) an array. Every page that reads `?key=` funnels through this
 * so the "string | string[] | undefined" unwrapping lives in one place.
 */
export function firstParam(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * *Every* value of a repeated search param — the counterpart to {@link firstParam}
 * for the keys where repetition is the point rather than an accident.
 * `?budget=everyday&budget=christmas` names two budgets to layer, and taking only
 * the first would silently drop one.
 *
 * Absent reads as empty, so a caller can tell "none given" from "one given" and
 * apply its own default.
 */
export function allParams(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}
