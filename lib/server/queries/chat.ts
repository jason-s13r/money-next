import "server-only";
import { connection } from "next/server";
import { cache } from "react";

import { requireWorkspace } from "../auth/session";
import { getDb } from "../db/request";
import type { ChatMessageView, ChatThreadView } from "../../chat/messages";
import { toMessageView } from "../../chat/messages";

// Reads for the chat pages, and **the only place a thread is looked up**.
//
// That is not a stylistic preference. A chat thread is private to its author, and
// `scopedDb` cannot enforce that: it filters by workspace, and RLS underneath it keys
// on `app.workspace_id`, so both stop another household and neither stops the other
// member of *this* one. The `userId` filter is what does, and it is application code.
// Application code that appears at five call sites is application code that will be
// four call sites the day someone adds a fifth in a hurry — so it appears here, once,
// and everything else goes through these functions.
//
// The corollary: **do not reach for `db.chatThread` outside this module** without the
// same filter. The turn endpoint is the one legitimate exception, because it must
// claim a thread atomically in the same statement it checks ownership with; it spells
// the filter out and says why.

/** The current user's threads, most recently used first. */
export const getChatThreads = cache(async (): Promise<ChatThreadView[]> => {
  await connection();
  const { user } = await requireWorkspace();
  const db = await getDb();

  const threads = await db.chatThread.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      updatedAt: true,
      runningSince: true,
      unattended: true,
      _count: { select: { messages: true } },
    },
  });

  return threads.map((thread) => ({
    id: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt.getTime(),
    running: thread.runningSince !== null,
    messages: thread._count.messages,
    unattended: thread.unattended,
  }));
});

/** One thread and everything said in it, or null when there is no such thread *for
 *  this user* — which is the same answer as "no such thread", deliberately: a 404
 *  tells someone nothing about whether a colleague's conversation exists. */
export const getChatThread = cache(
  async (id: string): Promise<{ thread: ChatThreadView; messages: ChatMessageView[] } | null> => {
    await connection();
    const { user } = await requireWorkspace();
    const db = await getDb();

    const thread = await db.chatThread.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        title: true,
        updatedAt: true,
        runningSince: true,
        unattended: true,
        continuedAt: true,
        model: true,
        summarizedThroughSeq: true,
        messages: {
          orderBy: { seq: "asc" },
          select: {
            id: true,
            seq: true,
            role: true,
            content: true,
            toolCalls: true,
            toolCallId: true,
            toolName: true,
          },
        },
      },
    });
    if (!thread) return null;

    return {
      thread: {
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt.getTime(),
        running: thread.runningSince !== null,
        messages: thread.messages.length,
        unattended: thread.unattended,
        continued: thread.continuedAt !== null,
        model: thread.model,
        // Counted from the rows rather than from the seq, because a seq is a position
        // and this is a quantity — "the first 24 of these are summarised" is what the
        // header has to say, and deleted rows would make the two disagree.
        compacted:
          thread.summarizedThroughSeq === null
            ? 0
            : thread.messages.filter((row) => row.seq <= thread.summarizedThroughSeq!).length,
      },
      messages: thread.messages.map(toMessageView),
    };
  },
);
