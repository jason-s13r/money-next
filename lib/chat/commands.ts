// What you can say to the app rather than to the model.
//
// Every one of these is something the buttons already do — stop, steer, queue, compact,
// choose a model. The point is not new capability, it is that your hands are already on
// the keyboard: the moment you most want to stop a model that has gone wandering is the
// moment you least want to go looking for a button.
//
// **A command is never a message.** It is parsed here, dispatched to a server action, and
// nothing is ever appended to the thread — the model does not see "/stop", and cannot,
// because a conversation full of instructions addressed to the app would be a conversation
// the model has to learn to ignore.
//
// Pure and here rather than in the composer because the parse has an edge that matters and
// no way to notice it in a browser: text that legitimately begins with a slash. See
// `parseCommand`.

/** Something the app does when you say so. */
export type ChatCommand = {
  name: string;
  /** What may follow the name. `required` is not validation — it is what the menu does
   *  when you press Enter on the entry: run it, or wait for the rest of the line.
   *
   *  `suggests` names a set of values the *caller* has and this module does not: the
   *  models an endpoint is serving are a network call away, and a pure module that both
   *  halves of the app import is not the place to make one. It says only that there is
   *  something to complete here — see `argumentMenu`. */
  argument?: { name: string; required: boolean; suggests?: "model" };
  summary: string;
  /** When it means anything. A command shown at a moment it cannot work is a command
   *  that will answer with an apology, so the menu offers only what applies. */
  when: "running" | "idle" | "always";
};

/**
 * Where the composer is, as far as the commands are concerned.
 *
 * `new` is the composer on /chat, before there is a thread at all: nothing to stop, steer
 * or compact, because none of them has anything to be done *to* yet — but choosing the
 * model still means something, and it is the one decision worth making before the first
 * question rather than after the first answer. So it is a third state and not a flavour
 * of `idle`.
 */
export type ChatState = "new" | "idle" | "running";

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    name: "stop",
    summary: "Stop the answer in progress, keeping what it has already said",
    when: "running",
  },
  {
    name: "steer",
    argument: { name: "instruction", required: true },
    summary: "Interrupt and redirect, keeping the tool results so far",
    when: "running",
  },
  {
    name: "next",
    argument: { name: "message", required: true },
    summary: "Hold this until the current answer finishes, then send it",
    when: "running",
  },
  {
    name: "compact",
    summary: "Summarise the earlier messages so the model carries less of them",
    when: "idle",
  },
  {
    name: "model",
    argument: { name: "name", required: false, suggests: "model" },
    summary: "Show which models this endpoint has, or switch to one",
    when: "always",
  },
  { name: "help", summary: "List these", when: "always" },
];

export type ParsedCommand = { command: ChatCommand; rest: string };

/**
 * A typed line as a command, or null when it is an ordinary thing to say.
 *
 * **An unrecognised slash word is a message, not a mistake.** `/Users/jason/statements`
 * and `/w/personal/chat` are things someone might reasonably paste into a conversation
 * about their money, and refusing to send them — or worse, swallowing them as a typo'd
 * command — loses what was typed to a rule they never agreed to. A slash only means
 * something when it is followed by a name that is actually a command. The menu is what
 * makes the real ones discoverable, so nothing is hidden by being strict here.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const space = trimmed.search(/\s/);
  const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const command = CHAT_COMMANDS.find((c) => c.name === name);
  if (!command) return null;

  return { command, rest: space === -1 ? "" : trimmed.slice(space).trim() };
}

/**
 * The commands to offer for what has been typed so far, or null for no menu at all.
 *
 * Only while the first word is still being typed: once there is a space the argument has
 * started, and a menu over someone's half-written sentence is in the way rather than
 * helpful.
 */
export function commandMenu(input: string, state: ChatState): ChatCommand[] | null {
  if (!input.startsWith("/") || /\s/.test(input)) return null;
  const typed = input.slice(1).toLowerCase();
  return CHAT_COMMANDS.filter(
    (command) => applies(command, state) && command.name.startsWith(typed),
  );
}

/** What a command's argument is being completed against right now. */
export type ArgumentMenu = { command: ChatCommand; matches: string[] };

/**
 * The values to offer for the argument of the command on this line, or null when the
 * line is not one that has anything to complete.
 *
 * The counterpart to `commandMenu`, for after the space: that one finishes the name, this
 * one finishes what follows it. Only for commands that declare `suggests` — most
 * arguments are a sentence addressed to the model, and there is nothing to offer someone
 * writing one.
 *
 * `values` comes from the caller because it is not knowable here: which models exist is
 * whatever the local endpoint has loaded. Matching is on any part of the name, since a
 * model id is often a path (`hf.co/someone/a-model:q4`) and the part a person remembers
 * is rarely the front of it. Ranked by where the match falls, so typing the beginning of
 * a name puts it at the top without hiding the rest.
 */
export function argumentMenu(input: string, values: string[]): ArgumentMenu | null {
  // A space after the name is what says the name is finished. `/mod` is still a command
  // being typed and belongs to `commandMenu`; `/model ` is an argument being typed.
  if (!/^\/\S+\s/.test(input)) return null;

  const parsed = parseCommand(input);
  if (!parsed?.command.argument?.suggests) return null;

  const typed = parsed.rest.toLowerCase();
  const matches = values
    .filter((value) => value.toLowerCase().includes(typed))
    .sort(
      (a, b) =>
        a.toLowerCase().indexOf(typed) - b.toLowerCase().indexOf(typed) || a.localeCompare(b),
    );

  return { command: parsed.command, matches };
}

/** Whether a command means anything at this moment. Only the two that are about the app
 *  rather than about a thread survive `new`, which is the point of that state. */
export function applies(command: ChatCommand, state: ChatState): boolean {
  return command.when === "always" || command.when === state;
}

/** The commands as `/help` prints them, filtered to what can be used right now. */
export function helpText(state: ChatState): string {
  const usable = CHAT_COMMANDS.filter((command) => applies(command, state));
  const width = Math.max(...usable.map((command) => label(command).length));
  return usable
    .map((command) => `${label(command).padEnd(width)}  ${command.summary}`)
    .join("\n");
}

/** How a command is written down: `<required>`, `[optional]`, the convention every
 *  usage line has used for decades. */
export function label(command: ChatCommand): string {
  if (!command.argument) return `/${command.name}`;
  const { name, required } = command.argument;
  return `/${command.name} ${required ? `<${name}>` : `[${name}]`}`;
}
