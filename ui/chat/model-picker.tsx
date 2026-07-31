"use client";

import { CheckIcon, CpuIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// Which model answers, per conversation.
//
// Per thread rather than per person, because the choice is about the conversation. A
// quick question wants the small fast model; the same person, in the next thread, asking
// it to work through a year of transactions wants the big slow one. Changing it mid-
// thread is allowed and takes effect on the next turn — the model in flight is already
// talking.
//
// **It says the name, not "Default".** A thread that has never been asked the question
// still has an answer — whatever `LLM_MODEL` is — and hiding it behind the word "default"
// meant the one thing the control exists to tell you was the one thing it would not say.
// So the button shows the model that will actually answer, the menu is one row per model,
// and the row that is the default is marked as such and is the one ticked on a thread that
// has never chosen.
//
// **There is no separate "follow the default" row**, and picking the default's own row is
// what unpins a thread — it stores no choice rather than the default's name. The two would
// look identical on screen and differ only months later, when `LLM_MODEL` changes and one
// thread moves with it; offering that as a choice is offering a distinction nobody can see
// they are making. Following is the behaviour of picking what is already the default, and
// that is the only way to get it.
//
// The list itself is fetched by whoever renders this — see ui/chat/composer.tsx — because
// it is a call to another process shared with `/model`'s completion, and asking twice for
// one list nobody has looked at yet is worse than passing it down.

type Props = {
  /** The thread's choice, or null when it follows the server's default. */
  model: string | null;
  /** What answers when nothing is pinned: `LLM_MODEL`, from the page's render. Known
   *  without asking the endpoint, which is what lets the button name it before the list
   *  has ever been opened. */
  fallback: string;
  /** What the endpoint is serving. Null until it has been asked. */
  models: string[] | null;
  /** Ask for the list, once, when the menu is first opened. */
  onOpen: () => void;
  onChoose: (model: string | null) => void;
  /** No switching mid-answer: it would not take effect until the turn ended anyway, and
   *  a control that silently does nothing is worse than one that is greyed out. */
  disabled: boolean;
};

export function ModelPicker({ model, fallback, models, onOpen, onChoose, disabled }: Props) {
  const answering = model ?? fallback;
  // The default belongs in the list whether or not the endpoint admits to having it: it is
  // what a thread that has not chosen will be answered by, so it has to be the row that is
  // ticked — and on a runtime that has not pulled it, it also has to be the row you can get
  // back to after trying something else.
  const rows = models === null || models.includes(fallback) ? models : [fallback, ...models];

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="max-w-44 min-w-0"
            aria-label="Model"
            title={
              model
                ? `This conversation is pinned to ${model}`
                : `Following the default model (${fallback})`
            }
          >
            <CpuIcon />
            <span className={cn("truncate", !model && "text-muted-foreground")}>
              {short(answering)}
            </span>
          </Button>
        }
      />
      {/* Wide enough for a real model id. They are path-like and long, and a menu that
          elides the middle of every name is a menu you cannot choose from — the button is
          the one place a name has to be cut to fit. */}
      <DropdownMenuContent align="end" className="max-w-[min(32rem,90vw)] min-w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Model for this chat</DropdownMenuLabel>
          <DropdownMenuSeparator />

          {rows === null ? (
            <DropdownMenuItem disabled>Looking…</DropdownMenuItem>
          ) : (
            rows.map((name) => (
              <DropdownMenuItem
                key={name}
                // Picking the default is unpinning — see the note above.
                onClick={() => onChoose(name === fallback ? null : name)}
              >
                <CheckIcon
                  className={cn("size-4 shrink-0", answering !== name && "invisible")}
                />
                <span className="min-w-0 break-all whitespace-normal">{name}</span>
                {name === fallback ? (
                  <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">
                    default
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))
          )}

          {/* Said as well as the default's own row, not instead of it: an endpoint that
              will not answer still has a model configured, and "nothing here" would read
              as a machine with no models rather than one that could not be asked. */}
          {models?.length === 0 ? (
            <DropdownMenuItem disabled>Could not reach the endpoint to list the rest</DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A model id short enough for a button. Local model names are mostly path-like —
 *  `library/qwen3:14b-instruct` — and the tail is the part that distinguishes them. */
function short(model: string): string {
  const tail = model.split("/").pop() ?? model;
  return tail.length > 24 ? `${tail.slice(0, 23)}…` : tail;
}
