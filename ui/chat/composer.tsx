"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import {
  ArchiveIcon,
  ClockIcon,
  CornerDownLeftIcon,
  SendIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { listModels } from "@/app/w/[workspace]/chat/actions";
import {
  argumentMenu,
  commandMenu,
  label,
  parseCommand,
  type ChatCommand,
  type ChatState,
  type ParsedCommand,
} from "@/lib/chat/commands";
import { cn } from "@/lib/utils";
import { ModelPicker } from "./model-picker";

// Where you type, and everything you can do from there.
//
// **There is one of these.** Every place in the app with something to say to a model uses
// it: the empty page at /chat, a conversation, and the log of a background run. They do
// not all offer the same things, and that is a matter of which handlers they pass rather
// than of which composer they picked — a control is on screen when it has something to
// act on. So the new-chat page has no Compact (there is nothing yet to summarise) and a
// run's log has no model picker (the run chose its model an hour ago), and neither needs a
// second component that looks almost like this one and drifts from it.
//
// Three different things can happen to a sentence typed mid-turn, and they are genuinely
// different, so there are three buttons rather than one that guesses:
//
//   **Steer** interrupts the completion in flight and puts the sentence in the thread, so
//   the model's next round sees it. For a model three tool calls into the wrong idea:
//   the work it has already done is kept, the direction is not.
//
//   **Queue** holds the sentence until the turn finishes and then sends it as the next
//   turn. For a follow-up you thought of while reading — you want the current answer,
//   and then this.
//
//   **Stop** ends the turn. What was already said stays; abandoned tool calls are
//   answered with a cancellation so the conversation can still be continued.
//
// Stop is a real stop now. It used to be labelled "Stop watching", because all it could
// do was close the reader while the server carried on — the turn belonged to the request,
// and there was nothing to address. It belongs to the thread now, so there is.
//
// **Which model, and compacting, live here too**, along the bottom of the box rather than
// up in the header. They were in the header because they are things done *to* a
// conversation rather than said in it, which is true and turned out not to be the point:
// both are decisions made with your hands on the keyboard and your eyes on what the model
// just did — "that answer was thin, try the big one"; "this is getting long". A control
// you only remember when you look up is a control you mostly do not use.
//
// The same five things, and the two thread-level ones, can be typed as `/commands` — see
// lib/chat/commands.ts. The menu completes both halves: the name while it is being typed,
// and then, for `/model`, the models the endpoint is actually serving.

type Props = {
  /** `new` on /chat, where there is no thread yet; `idle` and `running` in one. Drives
   *  the placeholder, which commands are offered, and whether something is in flight. */
  state: ChatState;
  onSend: (message: string) => void;
  /** Its own sentence, where the one for this state would be wrong — a run's log is a
   *  composer whose text is going to a worker in another process. */
  placeholder?: string;
  /** Outer chrome. The default assumes the usual place — the foot of a scrolling
   *  conversation, which is what the top border separates it from. */
  className?: string;
  /** False for a viewer: the model still reads and explains, it just cannot write. */
  canEdit?: boolean;

  // Everything below is a capability. Passed, the control appears; omitted, it does not,
  // because there is nothing for it to act on — see the note above.

  /** With `onChooseModel`: which model answers. Left out where the choice is already
   *  made and cannot be revisited. */
  model?: string | null;
  /** What answers when nothing is pinned — `LLM_MODEL`, known from the page's render. */
  defaultModel?: string;
  onChooseModel?: (model: string | null) => void;
  /** A compaction is running. It takes a round trip to the model, so it is worth saying. */
  compacting?: boolean;
  onCompact?: () => void;
  /** A message waiting for the turn to end, if any. */
  queued?: string | null;
  onQueue?: (message: string) => void;
  onUnqueue?: () => void;
  onSteer?: (message: string) => void;
  onStop?: () => void;
  /** `/commands`, which are addressed to the app about a thread. A composer with no
   *  thread behind it — a run's log — passes none, and gets no menu. */
  onCommand?: (parsed: ParsedCommand) => void;
};

/** One row of the menu, whichever half of it is showing. `pick(true)` runs the line;
 *  `pick(false)` only writes it into the box — Enter and Tab. */
type Entry = {
  key: string;
  code: string;
  tail: string | null;
  note: string;
  pick: (run: boolean) => void;
};

export function Composer({
  state,
  onSend,
  placeholder,
  className,
  canEdit = true,
  model = null,
  defaultModel,
  onChooseModel,
  compacting = false,
  onCompact,
  queued = null,
  onQueue,
  onUnqueue,
  onSteer,
  onStop,
  onCommand,
}: Props) {
  const busy = state === "running";
  const [value, setValue] = useState("");
  // Which entry the arrow keys are on, and whether Escape has closed the menu for this
  // word. Both reset as soon as the text changes: a highlight left over from what was
  // typed a moment ago would put Enter on the wrong command.
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // What the endpoint is serving, once anything has asked for it. Shared by the picker
  // and by `/model`'s completion, because it is one list and one call to another process.
  const [models, setModels] = useState<string[] | null>(null);
  const asked = useRef(false);

  /** Ask the endpoint what it has, once per mount. The list does change — a model gets
   *  pulled, another unloaded — but not while somebody is looking at one composer, and a
   *  request behind every keystroke of `/model ` would be worse than slightly stale. */
  const loadModels = () => {
    if (asked.current) return;
    asked.current = true;
    void listModels().then(setModels);
  };

  const change = (next: string) => {
    setValue(next);
    setHighlight(0);
    setDismissed(false);
    // Typing the space after `/model` is the request for the list: asked for here, in an
    // event, rather than while rendering the menu that wants it. `argumentMenu` against
    // no values answers the only question being put to it — is this line one with
    // something to complete?
    if (onChooseModel && argumentMenu(next, [])) loadModels();
  };

  const take = (): string | null => {
    const message = value.trim();
    if (!message) return null;
    setValue("");
    return message;
  };

  const submit = () => {
    const message = take();
    if (!message) return;

    // A command is addressed to the app, not to the model, so it never becomes a message
    // — including mid-turn, where an ordinary line would have steered. Where there are no
    // commands at all it is just a line beginning with a slash, and goes as one.
    const parsed = onCommand ? parseCommand(message) : null;
    if (parsed) return onCommand!(parsed);

    // Enter mid-turn steers rather than queues. Both are defensible defaults; steering is
    // the one you reach for urgently, and the one whose value evaporates if you have to
    // find the right button first.
    (busy && onSteer ? onSteer : onSend)(message);
  };

  const queue = () => {
    const message = take();
    if (message) onQueue?.(message);
  };

  const run = (command: ChatCommand, rest: string) => {
    setValue("");
    setHighlight(0);
    onCommand?.({ command, rest });
  };

  /** A command, as a row of the menu. Enter runs one that can work with nothing after it
   *  — that is the point of `/stop` over reaching for the button, and it is what makes
   *  Enter on `/model` list the models. Tab always just completes, which is how you get
   *  to typing the argument. */
  const commandEntry = (command: ChatCommand): Entry => ({
    key: command.name,
    code: `/${command.name}`,
    tail: command.argument ? label(command).slice(command.name.length + 1) : null,
    note: command.summary,
    pick: (immediately) =>
      immediately && !command.argument?.required
        ? run(command, "")
        : change(`/${command.name} `),
  });

  /** A model name, as a row of the menu. Enter switches to it; Tab writes it into the
   *  line and leaves it there to be read. */
  const modelEntry = (command: ChatCommand, name: string): Entry => ({
    key: name,
    code: name,
    tail: null,
    note: [name === (model ?? defaultModel) ? "this chat" : null, name === defaultModel ? "the default" : null]
      .filter(Boolean)
      .join(" · "),
    pick: (immediately) =>
      immediately ? run(command, name) : change(`/${command.name} ${name}`),
  });

  // No menu at all where nothing can be commanded: see `onCommand`.
  const commands = dismissed || !onCommand ? null : commandMenu(value, state);
  const argument = dismissed || !onCommand ? null : argumentMenu(value, models ?? []);
  const menu: Entry[] = commands
    ? commands.map(commandEntry)
    : argument
      ? argument.matches.map((name) => modelEntry(argument.command, name))
      : [];
  const open = menu.length > 0;
  const active = open ? menu[Math.min(highlight, menu.length - 1)] : null;

  // Enter sends, Shift+Enter breaks the line — the convention every chat has, and
  // worth having because most messages here are one line. While the menu is open the
  // arrows and Enter belong to it instead.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : menu.length - 1;
        setHighlight((current) => (Math.min(current, menu.length - 1) + step) % menu.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        if (!active) return;
        event.preventDefault();
        active.pick(event.key === "Enter");
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={cn("border-t border-border bg-background px-2 py-3", className)}>
      {open ? (
        <ul
          role="listbox"
          aria-label={commands ? "Commands" : "Models"}
          className="mb-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover text-sm"
        >
          {menu.map((entry, index) => (
            <li key={entry.key}>
              <button
                type="button"
                role="option"
                aria-selected={entry === active}
                // Mouse down rather than click: the textarea loses focus first otherwise,
                // and a composer that has to be clicked back into is worse than no menu.
                onMouseDown={(event) => {
                  event.preventDefault();
                  entry.pick(true);
                }}
                onMouseEnter={() => setHighlight(index)}
                className={cn(
                  "flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors",
                  entry === active ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                <span className="min-w-0 truncate font-mono text-xs whitespace-pre">
                  {entry.code}
                  {entry.tail ? <span className="text-muted-foreground">{entry.tail}</span> : null}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {entry.note}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {queued ? (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <ClockIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Next: {queued}</span>
          <button
            type="button"
            onClick={onUnqueue}
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Cancel queued message"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ) : null}

      {/* One box. The textarea's own border and focus ring are dropped and taken over by
          this element, so what lights up when you click into it is the whole composer
          rather than a field with some buttons loose underneath it. */}
      <div className="rounded-xl border border-input transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
        <Textarea
          value={value}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder ?? defaultPlaceholder(state, canEdit)}
          className="max-h-48 min-h-9 resize-none border-0 bg-transparent focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          aria-label="Message"
        />

        {/* Everything on one right-hand end: the two quiet settings and then what you
            actually press, in the order they are reached for. Ghost against the solid
            Send, so the pair reads as the state of the box rather than as two more
            things to do. */}
        <div className="flex flex-wrap items-center justify-end gap-1 px-1.5 pb-1.5">
          {onChooseModel && defaultModel ? (
            <ModelPicker
              model={model}
              fallback={defaultModel}
              models={models}
              onOpen={loadModels}
              onChoose={onChooseModel}
              disabled={busy}
            />
          ) : null}
          {onCompact ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-w-0"
              onClick={onCompact}
              disabled={busy || compacting}
              aria-label="Compact conversation"
              title="Summarise the earlier messages so the model carries less of them. Nothing is deleted."
            >
              <ArchiveIcon />
              <span className="truncate text-muted-foreground">
                {compacting ? "Summarising…" : "Compact"}
              </span>
            </Button>
          ) : null}

          {/* Queue and Steer are the two halves of "not now" and "not that", and they
              only exist where a turn of ours is in flight to have them done to it. Where
              nothing is in flight — and where something is, but is somebody else's, which
              is what a run's log is — Send is the whole answer: it goes to the model, or
              to the run, and that is the difference between the two callers rather than
              between two buttons. */}
          <div className="flex items-center gap-1.5 pl-1">
            {busy && (onQueue || onSteer) ? (
              <>
                {onQueue ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={queue}
                    disabled={!value.trim()}
                    aria-label="Queue for after this answer"
                    title="Send this after the current answer finishes"
                  >
                    <ClockIcon />
                    Queue
                  </Button>
                ) : null}
                {onSteer ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={submit}
                    disabled={!value.trim()}
                    aria-label="Steer this answer"
                    title="Interrupt and redirect the answer in progress"
                  >
                    <CornerDownLeftIcon />
                    Steer
                  </Button>
                ) : null}
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={submit}
                disabled={!value.trim()}
                aria-label="Send"
              >
                <SendIcon />
                Send
              </Button>
            )}

            {busy && onStop ? (
              <Button type="button" variant="destructive" size="sm" onClick={onStop} aria-label="Stop">
                <SquareIcon />
                Stop
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function defaultPlaceholder(state: ChatState, canEdit: boolean): string {
  if (state === "running") return "Redirect it, queue something for after, or / to control it…";
  if (!canEdit) return "Ask about your spending… (read-only: nothing here can be changed)";
  return state === "new"
    ? "Ask about your spending, or ask it to sort out your uncategorised… (/ for commands)"
    : "Ask anything else, or / for commands…";
}
