/** Short random id for graph nodes/edges/rows. */
export function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
