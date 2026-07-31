"use client";

import { useActionState } from "react";
import { Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ChatThreadView } from "@/lib/chat/messages";
import { Link } from "@/ui/chrome/workspace-context";
import { deleteThread } from "../actions";
import { NO_ERROR, type ChatActionState } from "../types";

// The head of a log, which is most of a thread header with most of it taken out.
//
// No rename (the title is the run and its time, and means something), no compact and no
// model picker: nothing is asked of a model from in here while it is a log, and once it
// is continued (see `continueLog`) this is not the header any more — the thread stops
// being unattended and the page renders the ordinary one, controls and all. Delete stays:
// a log is yours, and throwing it away is the one thing you can always do to it.

export function LogHeader({ thread }: { thread: ChatThreadView }) {
  const [, remove] = useActionState<ChatActionState, FormData>(deleteThread, NO_ERROR);

  return (
    <header className="flex items-center justify-between gap-3 border-b border-border pb-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{thread.title}</p>
        <p className="text-xs text-muted-foreground">
          {thread.running ? "Background run, in progress" : "Background run"}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/chat" />}>
          All chats
        </Button>
        <form action={remove}>
          <input type="hidden" name="threadId" value={thread.id} />
          <Button type="submit" variant="ghost" size="sm" aria-label="Delete log">
            <Trash2Icon />
          </Button>
        </form>
      </div>
    </header>
  );
}
