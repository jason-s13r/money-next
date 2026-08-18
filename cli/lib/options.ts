/**
 * Option value parsers. Commander runs these before the action sees the value,
 * so a rule written here fires everywhere the option is declared rather than in
 * whichever commands remembered it.
 */
import { InvalidArgumentError } from "commander";

/**
 * Addresses are stored lowercased (Better Auth normalizes on sign-up), so
 * `--email SAM@example.com` would otherwise report a real account as missing.
 */
export function normalizedEmail(value: string): string {
  return value.toLowerCase();
}

/**
 * A count of days, or anything else meaningless at zero. `InvalidArgumentError`
 * so Commander prefixes the option's own name — the message need not name it.
 */
export function positiveInt(value: string): number {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) {
    throw new InvalidArgumentError(`Expected a positive number, got "${value}".`);
  }
  return days;
}
