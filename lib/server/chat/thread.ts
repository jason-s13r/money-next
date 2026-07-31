// No `import "server-only"`: the interactive chat is the main caller and is
// request-bound, but the budget inference writes its log through `appendMessage` too
// (lib/server/budget/inference-log.ts) and that runs in the worker, where `server-only`
// throws. Nothing here is request-bound anyway — every function takes its scoped db as
// an argument, for the same reason.
import type { ScopedDb } from "../db";

// The writing half of a thread. The reasoning half — rebuilding a conversation, and
// deciding what the model still gets to see — is in lib/chat/thread.ts, where a test
// can reach it without a database.

export {
  CONTEXT_TOOL_BUDGET,
  elidedContent,
  elisionsFor,
  toModelMessages,
  type StoredMessage,
} from "../../chat/thread";

/** Persist the elision decision. Best-effort by design: failing to mark a row does not
 *  invalidate the turn that is about to run with it already applied. */
export async function markElided(db: ScopedDb, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.chatMessage.updateMany({ where: { id: { in: ids } }, data: { elided: true } });
}

/**
 * Append a message to a thread, taking the next `seq`.
 *
 * The unique index on `[threadId, seq]` is what makes this safe rather than the count
 * being read first: two writers racing produce a constraint violation, not two messages
 * silently sharing a position — and losing a message's *place* in a conversation is
 * losing the conversation, because a tool result that floats above its call is one the
 * endpoint refuses.
 *
 * There used to be only one writer, and this used to say a retry loop would be machinery
 * for a case that could not happen. Steering is that case: someone redirects a turn while
 * the loop is writing, and the two collide on a seq. Rare, brief, and resolved by looking
 * again — so the retry is small and deliberately not a transaction.
 */
export async function appendMessage(
  db: ScopedDb,
  threadId: string,
  message: {
    role: string;
    content?: string | null;
    toolCalls?: unknown;
    toolCallId?: string | null;
    toolName?: string | null;
  },
): Promise<{ id: string; seq: number }> {
  for (let attempt = 0; ; attempt++) {
    const last = await db.chatMessage.findFirst({
      where: { threadId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });

    try {
      return await db.chatMessage.create({
        data: {
          workspaceId: db.$workspaceId,
          threadId,
          seq: (last?.seq ?? -1) + 1,
          role: message.role,
          content: message.content ?? null,
          toolCalls: (message.toolCalls ?? undefined) as never,
          toolCallId: message.toolCallId ?? null,
          toolName: message.toolName ?? null,
        },
        select: { id: true, seq: true },
      });
    } catch (error) {
      if (attempt >= SEQ_RETRIES || !isSeqCollision(error)) throw error;
    }
  }
}

const SEQ_RETRIES = 5;

/** A duplicate `[threadId, seq]`, as Prisma reports it. */
function isSeqCollision(error: unknown): boolean {
  return (error as { code?: string })?.code === "P2002";
}
