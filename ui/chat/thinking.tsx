"use client";

import { useEffect, useRef, useState } from "react";
import { BrainIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";

// The model reasoning — while it is reasoning, and afterwards.
//
// Local models of the size this app runs think out loud in `<think>` tags, and the
// middleware in lib/server/chat/client.ts splits that off from what they actually say —
// so by the time it arrives here it is already separated, and the only question is what
// to do with it. This shows it, because a minute of "Thinking…" with no sign of what
// about is the difference between waiting and wondering whether it has hung.
//
// **It stays once it is done.** It used to be one live box that emptied the moment the
// model started speaking, which meant the only chance to read the working was while it
// was still being written — and reasoning worth reading is exactly the reasoning that
// goes past too fast. So a block of it is now a bubble in the conversation like any
// other, left where it happened: before the tool call it decided on, or before the
// answer it led to. Collapsed, so the answer is not buried under the working.
//
// **Still not persisted, and deliberately.** The thread stores what was said and what
// was done; reasoning is scaffolding and is not shown back to the model, so keeping it
// would grow every thread for something the next turn cannot use. It lives as long as
// the page does — a reload shows the conversation without it.

export function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const tail = useRef<HTMLDivElement>(null);

  // Follow the stream while it is expanded. Scrolls its own box rather than the page, so
  // reading further up the conversation is not fought over. Only while live: a finished
  // block someone has opened to read should stay where they put it.
  useEffect(() => {
    if (open && live) tail.current?.scrollIntoView({ block: "end" });
  }, [open, live, text]);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-dashed border-border bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
        aria-expanded={open}
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <BrainIcon className={cn("size-3.5 shrink-0", live && "animate-pulse")} />
        <span className="font-medium text-foreground">{live ? "Thinking" : "Thought"}</span>
        {open ? null : <span className="truncate italic">{plain(lastLine(text))}</span>}
      </button>

      {open ? (
        // Taller once it is finished: reading the whole thing back is the point of
        // keeping it, and a 12rem window on a long stretch of reasoning is a keyhole.
        <div
          className={cn(
            "overflow-y-auto border-t border-border px-3 py-2",
            live ? "max-h-48" : "max-h-96",
          )}
        >
          {/* The same renderer the answers use. A model reasoning about spending writes
              headings, lists and tables exactly as it does when answering, and showing
              that as raw `###` and `**` is harder to read than the prose it is made of.
              Smaller and greyer, so an opened block still reads as the working. */}
          <Markdown className="text-xs text-muted-foreground">{text}</Markdown>
          <div ref={tail} />
        </div>
      ) : null}
    </div>
  );
}

/** The most recent thing it said to itself. Reasoning arrives a token at a time, so the
 *  end of the text is the live edge; the paragraph it belongs to is what reads as a
 *  thought rather than a fragment. */
function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1] ?? "";
}

/** Markdown marks off the one line shown collapsed. The body renders them; a preview
 *  clipped mid-line cannot, so `### **Weekly total**` would show its punctuation and
 *  waste the width it has. Cosmetic, and only ever applied to that one line. */
function plain(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/[*_`~]/g, "")
    .trim();
}
