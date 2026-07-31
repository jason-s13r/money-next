"use client";

import { useActionState, useState } from "react";
import { Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatThreadView } from "@/lib/chat/messages";
import { Link } from "@/ui/chrome/workspace-context";
import { deleteThread, renameThread } from "../actions";
import { NO_ERROR, type ChatActionState } from "../types";

// The thread's name, renameable in place, and the way out.
//
// It used to hold the model picker and the compact button too. Both have moved into the
// composer (ui/chat/composer.tsx): they are decisions made while reading an answer, and a
// control at the other end of the screen from the keyboard is one nobody reaches for. What
// is left here is what a header is for — what this conversation is called, and leaving.
//
// The count of summarised messages stays, though, because it is a fact about the thread
// rather than a control: it explains why the model does not remember the top of a page you
// can still scroll to.

export function ThreadHeader({ thread }: { thread: ChatThreadView }) {
  const [editing, setEditing] = useState(false);
  const [renameState, rename] = useActionState<ChatActionState, FormData>(renameThread, NO_ERROR);
  const [, remove] = useActionState<ChatActionState, FormData>(deleteThread, NO_ERROR);

  return (
    <header className="flex items-center justify-between gap-3 border-b border-border pb-2">
      {editing ? (
        <form
          action={(form) => {
            setEditing(false);
            rename(form);
          }}
          className="flex min-w-0 flex-1 gap-2"
        >
          <input type="hidden" name="threadId" value={thread.id} />
          <Input
            name="title"
            defaultValue={thread.title}
            autoFocus
            aria-label="Conversation name"
            onBlur={() => setEditing(false)}
          />
          <Button type="submit" size="sm" variant="outline">
            Rename
          </Button>
        </form>
      ) : (
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="w-full truncate text-left text-sm font-medium hover:opacity-80"
            title="Rename"
          >
            {thread.title}
          </button>
          {/* Where the conversation came from, when that is not "somebody opened one".
              The messages above the takeover were written by a worker, and this is the
              only thing on the page that says so once the log has become a chat. */}
          {thread.continued ? (
            <p className="text-xs text-muted-foreground">Continued from a background run</p>
          ) : null}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2">
        {renameState.error ? (
          <span role="alert" className="text-xs text-status-critical">
            {renameState.error}
          </span>
        ) : null}

        {thread.compacted ? (
          <span
            className="text-xs text-muted-foreground"
            title={`The first ${thread.compacted} messages are summarised for the model. They are all still here to read.`}
          >
            {thread.compacted} summarised
          </span>
        ) : null}

        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/chat" />}>
          All chats
        </Button>
        <form action={remove}>
          <input type="hidden" name="threadId" value={thread.id} />
          <Button type="submit" variant="ghost" size="sm" aria-label="Delete conversation">
            <Trash2Icon />
          </Button>
        </form>
      </div>
    </header>
  );
}
