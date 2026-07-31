import { notFound } from "next/navigation";

import { ForbiddenError, requireRole } from "@/lib/server/auth/session";
import { MODEL } from "@/lib/server/chat/client";
import { getChatThread } from "@/lib/server/queries/chat";
import { workspacePath } from "@/lib/workspace-path";
import { Conversation } from "@/ui/chat/conversation";
import { LogView } from "./log-view";
import { ThreadHeader } from "./thread-header";

// One conversation.
//
// The page is a server component that hands the thread to client ones and gets out of
// the way; everything live happens over the turn route, not through this render.
//
// Unless the thread is a log of a background run (`ChatThread.unattended`), which is the
// same rows shown read-only, with a way to talk to the run or take the log over
// afterwards. That is a branch here rather than a prop, because the two views share
// nothing that matters: a log has no turn to attach to and no composer.
//
// `MODEL` is read here, in a render, and passed down: it is an environment variable, so
// knowing it costs nothing, and it is what lets the composer name the model that will
// answer instead of calling it "the default".

export async function generateMetadata(props: PageProps<"/w/[workspace]/chat/[thread]">) {
  const found = await getChatThread((await props.params).thread);
  return { title: found?.thread.title ?? "Chat" };
}

export default async function ChatThreadPage(props: PageProps<"/w/[workspace]/chat/[thread]">) {
  const { workspace, thread: threadId } = await props.params;
  const found = await getChatThread(threadId);
  // Null covers "no such thread" and "not yours" alike, and 404 is the right answer to
  // both — the same reasoning as `requireWorkspace`'s notFound for a workspace you are
  // not a member of. Whether a colleague's conversation exists is not yours to learn.
  if (!found) notFound();

  if (found.thread.unattended) {
    return (
      <main className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-3xl flex-col p-2">
        <LogView thread={found.thread} messages={found.messages} />
      </main>
    );
  }

  return (
    <main className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-3xl flex-col p-2">
      <ThreadHeader thread={found.thread} />
      <Conversation
        threadId={found.thread.id}
        turnUrl={workspacePath(workspace, `/chat/${found.thread.id}/turn`)}
        initial={found.messages}
        model={found.thread.model ?? null}
        defaultModel={MODEL}
        running={found.thread.running}
        canEdit={await canEdit()}
      />
    </main>
  );
}

/**
 * Whether this person may change *anything* the chat can change, as one boolean.
 *
 * Deliberately either grant rather than both, and deliberately coarser than what the
 * turn endpoint asks: this only decides whether the composer says "read-only", and the
 * two grants are separate (see lib/server/auth/roles.ts), so somebody who may
 * recategorise but not budget is not read-only and must not be told they are. Which
 * half they hold is settled per tool, where it can be settled precisely —
 * `availableTools` offers exactly the tools they can run.
 */
async function canEdit(): Promise<boolean> {
  const permissions: Parameters<typeof requireRole>[0][] = [
    { budget: ["update"] },
    { enrichment: ["update"] },
  ];
  for (const permission of permissions) {
    try {
      await requireRole(permission);
      return true;
    } catch (error) {
      if (!(error instanceof ForbiddenError)) throw error;
    }
  }
  return false;
}
