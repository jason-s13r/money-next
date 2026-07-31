import type { StoredMessage } from "./thread";

// Where a conversation may be cut in two, which is the one part of compaction that has
// to be right.
//
// Here rather than beside the model call for the reason the rest of this directory
// exists: the failure is silent. A cut in the wrong place does not throw — it produces a
// conversation whose first tool result answers a call that is no longer there, and the
// endpoint refuses the *next* turn, in a thread that had been working all week.

/** How much of the tail is left alone. Compacting up to the last thing said would
 *  summarise the question being answered right now, which reads as amnesia; a few real
 *  turns after the summary keep the immediate thread of the conversation intact. */
export const KEEP_RECENT = 6;

/**
 * The seq to summarise through, or null when there is nothing worth summarising.
 *
 * Walks back from the end past `keepRecent` messages, then keeps walking until it is
 * standing on the last message of a *completed* exchange — a user message, or an
 * assistant message that asked for nothing. Landing on a tool result would strand it from
 * its call; landing on an assistant message that called tools would strand the results
 * that follow it.
 *
 * @param already the seq a previous compaction already covered, so a second one starts
 *   where the first stopped rather than resummarising a summary.
 */
export function compactionCut(
  rows: StoredMessage[],
  already: number = -1,
  keepRecent: number = KEEP_RECENT,
): number | null {
  const fresh = rows.filter((row) => row.seq > already);
  if (fresh.length <= keepRecent) return null;

  for (let i = fresh.length - 1 - keepRecent; i >= 0; i--) {
    const row = fresh[i];
    if (row.role === "user") return row.seq;
    if (row.role === "assistant" && !hasCalls(row)) return row.seq;
  }
  return null;
}

function hasCalls(row: StoredMessage): boolean {
  return Array.isArray(row.toolCalls) && row.toolCalls.length > 0;
}
