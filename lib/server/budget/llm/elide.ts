import type { ModelMessage } from "ai";

import type { Area } from "../../chat/tools";

/**
 * Drop an area's served transactions from the conversation once it is done with.
 *
 * The single conversation is the point of this design — the model carries what it
 * learned in one area into the next — but the *transactions* are not what it needs
 * to carry, and leaving thousands of them in front of it is what runs a local
 * model's context out three areas in. The tool results are replaced in place, so the
 * call/result pairing the API requires stays intact and only the bulk goes.
 *
 * Found by call id rather than by position, since a round's results arrive grouped into
 * one message and there is no reason to care which. The same trade the chat makes with
 * `elided` on a stored row, arrived at here first and for the same wall.
 *
 * Returns the calls it dropped, so the run's log can mark the same rows — the log keeps
 * every transaction it was served, and `elided` there says only that the model stopped
 * carrying them.
 */
export function elideServedRows(
  messages: ModelMessage[],
  servedRows: Map<string, string[]>,
  area: Area,
): string[] {
  const served = new Set(servedRows.get(area.groupId) ?? []);
  if (served.size === 0) return [];

  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || !served.has(part.toolCallId)) continue;
      part.output = {
        type: "json",
        value: {
          area: area.name,
          elided: `Transactions dropped — ${area.name} has been proposed for.`,
        },
      };
    }
  }
  servedRows.delete(area.groupId);
  return [...served];
}
