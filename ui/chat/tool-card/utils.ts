export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const asRows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

export const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

export const str = (value: unknown) =>
  value === null || value === undefined ? "" : String(value);

export const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
