// Constants and types shared across the ingest step modules (categories, fx,
// accounts, transactions, pending) and the `runSync` orchestrator in sync.ts.

export const DAY_MS = 24 * 60 * 60 * 1000;

export type SyncArgs = { full: boolean; days?: number };

/** Turn an Akahu date string into a `Date`, or `null` when absent/unparseable. */
export function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
