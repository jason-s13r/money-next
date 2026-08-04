import "server-only";
import { generateText } from "ai";

import type { ScopedDb } from "../db";
import { LLM_TIMEOUT, MODEL, languageModel } from "./client";
import { compactionCut } from "../../chat/compact";
import { COMPACT_PROMPT } from "../../chat/prompt";
import { elidedContent, toModelMessages, type StoredMessage } from "./thread";

// Compacting a conversation: replacing what was said with an account of it. A
// local model has a fixed window, and a long conversation fills it — the turn
// after that simply fails. `ChatMessage.elided` fights the biggest part by
// dropping old tool output, but a conversation can be long in the ordinary way
// too. The messages are not deleted: `summarizedThroughSeq` moves the model's
// view forward; the rows stay, and the page still renders all of them.
//
// Summarising is a model call, so it can fail or be slow, and it deliberately
// does not go through the turn machinery: nothing is appended to the thread,
// nothing streams, and a failure leaves the conversation exactly as it was.

export type CompactResult = { ok: true; through: number } | { ok: false; error: string };

/**
 * Summarise everything up to a few messages from the end, and record it on the
 * thread. Where the cut falls is `compactionCut`'s business, and the one part of
 * this worth testing: a boundary between a tool call and its result produces a
 * conversation the endpoint refuses on the *next* turn.
 */
export async function compactThread(
  db: ScopedDb,
  threadId: string,
  modelId: string | null,
): Promise<CompactResult> {
  const model = languageModel(modelId ?? MODEL);
  if (!model) return { ok: false, error: "No model is configured. Set LLM_API to a local endpoint." };

  const rows = (await db.chatMessage.findMany({
    where: { threadId },
    orderBy: { seq: "asc" },
    select: {
      id: true,
      seq: true,
      role: true,
      content: true,
      toolCalls: true,
      toolCallId: true,
      toolName: true,
      elided: true,
    },
  })) as StoredMessage[];

  const thread = await db.chatThread.findFirst({
    where: { id: threadId },
    select: { summary: true, summarizedThroughSeq: true },
  });

  const already = thread?.summarizedThroughSeq ?? -1;
  const through = compactionCut(rows, already);
  if (through === null) {
    return { ok: false, error: "There is not enough here to be worth compacting yet." };
  }

  // Everything not already summarised, up to the cut. The earlier summary goes in as the
  // opening of the transcript, so compacting twice folds the first summary into the
  // second rather than losing what it covered.
  const window = rows.filter((row) => row.seq > already && row.seq <= through);

  // Tool output is elided wholesale here regardless of the row's own flag. A summary is
  // about what was concluded, and feeding a summariser the hundred kilobytes of JSON
  // that made the thread too long is self-defeating.
  const forgetful = window.map((row) =>
    row.role === "tool" ? { ...row, content: elidedContent(row.toolName), elided: true } : row,
  );

  const transcript = toModelMessages(forgetful);
  if (transcript.length === 0) {
    return { ok: false, error: "There is not enough here to be worth compacting yet." };
  }

  let summary: string;
  try {
    const result = await generateText({
      model,
      instructions: thread?.summary
        ? `Everything before the transcript below was already summarised as:\n\n${thread.summary}\n\nFold that into your answer, so what you write stands alone as the record of the whole conversation.`
        : undefined,
      messages: [...transcript, { role: "user", content: COMPACT_PROMPT }],
      timeout: LLM_TIMEOUT,
      // Nothing here should be invented, and a summary that varies between runs of the
      // same conversation is a summary nobody can check.
      temperature: 0,
    });
    summary = result.text.trim();
  } catch (error) {
    console.error("  [chat] compaction failed:", error);
    return { ok: false, error: "Could not summarise the conversation. Try again." };
  }

  if (!summary) return { ok: false, error: "The model returned an empty summary." };

  await db.chatThread.updateMany({
    where: { id: threadId },
    data: { summary, summarizedThroughSeq: through },
  });

  return { ok: true, through };
}

