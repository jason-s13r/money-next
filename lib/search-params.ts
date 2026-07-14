/**
 * The first value of a Next.js search param, which may be absent or (when the key
 * repeats in the url) an array. Every page that reads `?key=` funnels through this
 * so the "string | string[] | undefined" unwrapping lives in one place.
 */
export function firstParam(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}
