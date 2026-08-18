/**
 * Prints a shell completion script for this CLI.
 *
 *   money completion bash > ~/.bashrc.d/moneycli.sh
 *   money completion zsh  > ~/.zfunc/_money
 *   money completion fish > ~/.config/fish/completions/money.fish
 *
 * Commander ships no completion of its own, but the program is walkable —
 * `.commands`, `.options`, `Option.long/argChoices` — so the tree is read once
 * here and written out as literal word lists.
 *
 * Static rather than a runtime callback. The tabtab/omelette style re-invokes the
 * binary on every TAB, and on the production host `money` is reached through
 * `podman exec` — so each keypress would cost a container round trip and a
 * node+tsx boot. Baking the tree in makes TAB pure shell; the price is
 * regenerating when a command is added, which is a deploy-time step.
 *
 * Nothing here completes *values* out of the database — slugs, link ids,
 * addresses — for the same reason. Enum flags like `--role` do complete, since
 * Commander already knows their choices.
 */
import { Command } from "commander";

/** One node of the tree, flattened: how you'd reach it, and what it accepts. */
type Node = {
  /** Subcommand path, e.g. `["user", "create"]`. Empty for the root. */
  path: string[];
  /** Names of its subcommands. */
  subcommands: string[];
  /** Its own long flags, including `--help`. */
  flags: string[];
  /** Flags with a fixed set of values, for completing the word after them. */
  choices: { flag: string; values: string[] }[];
};

const SHELLS = ["bash", "zsh", "fish"] as const;
type Shell = (typeof SHELLS)[number];

export function register(program: Command): void {
  program
    .command("completion")
    .description("Print a shell completion script for this CLI")
    .argument("<shell>", `one of: ${SHELLS.join(", ")}`)
    .option(
      "--command <name>",
      "the command name to complete (repeatable)",
      (value: string, all: string[]) => [...all, value],
      // Both, by default: `money` is what the container has on PATH, `moneycli`
      // is the alias the host reaches it through (deploy/quadlet/install.sh).
      // Registering for a name that does not exist costs nothing.
      ["money", "moneycli"],
    )
    .addHelpText(
      "after",
      `
  money completion bash > ~/.bashrc.d/moneycli.sh
  money completion zsh  > ~/.zfunc/_money
  money completion fish > ~/.config/fish/completions/money.fish

The tree is baked into the output rather than queried at completion time, so TAB
costs nothing — re-run this after adding a command. Values that live in the
database (workspace slugs, link ids) are deliberately not completed.
`,
    )
    .action((shell: string, opts: { command: string[] }, command: Command) => {
      if (!isShell(shell)) {
        throw new Error(`No completion for "${shell}". Choose one of: ${SHELLS.join(", ")}.`);
      }

      // The root is the program this command was registered on, not this command
      // — walking from `command` would complete `money completion` and nothing
      // else.
      const root = rootOf(command);
      const tree = walk(root, []);
      const names = dedupe(opts.command);

      console.log(generate(shell, tree, names));
    });
}

function isShell(value: string): value is Shell {
  return (SHELLS as readonly string[]).includes(value);
}

function rootOf(command: Command): Command {
  let node = command;
  while (node.parent) node = node.parent;
  return node;
}

const dedupe = (values: string[]) => [...new Set(values)];

/** Every command in the tree, depth-first, hidden ones left out. */
function walk(command: Command, path: string[]): Node[] {
  const visible = command.commands.filter((child) => !isHidden(child));

  const node: Node = {
    path,
    subcommands: visible.map((child) => child.name()),
    flags: ["--help", ...command.options.filter((o) => o.long && !o.hidden).map((o) => o.long!)],
    choices: command.options
      .filter((o) => o.long && !o.hidden && o.argChoices?.length)
      .map((o) => ({ flag: o.long!, values: o.argChoices! })),
  };

  return [node, ...visible.flatMap((child) => walk(child, [...path, child.name()]))];
}

/** Commander marks a hidden command by an empty description or `_hidden`. */
function isHidden(command: Command): boolean {
  return (command as unknown as { _hidden?: boolean })._hidden === true;
}

function generate(shell: Shell, tree: Node[], names: string[]): string {
  if (shell === "bash") return bash(tree, names);
  if (shell === "zsh") return zsh(tree, names);
  return fish(tree, names);
}

/** The key a node is looked up by: its path, space-joined. "" is the root. */
const key = (node: Node) => node.path.join(" ");

/** Everything completable at a node: its subcommands, then its flags. */
const words = (node: Node) => [...node.subcommands, ...node.flags].join(" ");

/**
 * Bash: walk the typed words down the tree, then `compgen -W` whatever that node
 * offers. The `case` is over the path rather than over `COMP_CWORD`, so nesting
 * costs nothing and a command with no subcommands simply offers its flags.
 */
function bash(tree: Node[], names: string[]): string {
  const cases = tree
    .map((node) => `    "${key(node)}") words="${words(node)}" ;;`)
    .join("\n");

  const choiceCases = tree
    .flatMap((node) =>
      node.choices.map(
        (choice) => `    "${key(node)}|${choice.flag}") words="${choice.values.join(" ")}" ;;`,
      ),
    )
    .join("\n");

  return `# money CLI completion (bash). Generated by \`money completion bash\`.
_money_completion() {
  local cur prev path i words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # The subcommand path typed so far: every non-flag word after the binary,
  # excluding the one being typed.
  path=""
  for ((i = 1; i < COMP_CWORD; i++)); do
    case "\${COMP_WORDS[i]}" in
      -*) continue ;;
    esac
    # Stop at the first word that is not a known subcommand — it is an argument.
    case "\${path:+$path }\${COMP_WORDS[i]}" in
${cases}
      *) break ;;
    esac
    path="\${path:+$path }\${COMP_WORDS[i]}"
  done

  # A flag that takes a fixed set of values completes those instead.
  words=""
  case "$path|$prev" in
${choiceCases || '    "|") ;;'}
  esac
  if [ -n "$words" ]; then
    mapfile -t COMPREPLY < <(compgen -W "$words" -- "$cur")
    return
  fi

  words=""
  case "$path" in
${cases}
  esac

  mapfile -t COMPREPLY < <(compgen -W "$words" -- "$cur")
}

${names.map((name) => `complete -F _money_completion ${name}`).join("\n")}
`;
}

/**
 * Zsh: `_arguments` per level would mean generating a state machine; this uses
 * the same path-walk as bash with `_describe`, which is less clever and behaves
 * identically for a tree of this shape.
 */
function zsh(tree: Node[], names: string[]): string {
  const cases = tree
    .map((node) => `    "${key(node)}") words=(${words(node)}) ;;`)
    .join("\n");

  const choiceCases = tree
    .flatMap((node) =>
      node.choices.map(
        (choice) => `    "${key(node)}|${choice.flag}") words=(${choice.values.join(" ")}) ;;`,
      ),
    )
    .join("\n");

  return `#compdef ${names.join(" ")}
# money CLI completion (zsh). Generated by \`money completion zsh\`.
_money_completion() {
  local path="" prev="\${words[CURRENT-1]}" word
  local -a words_out

  local i
  for (( i = 2; i < CURRENT; i++ )); do
    word="\${words[i]}"
    [[ "$word" == -* ]] && continue
    case "\${path:+$path }$word" in
${cases.replace(/words=\(/g, "words_out=(")}
      *) break ;;
    esac
    path="\${path:+$path }$word"
  done

  words_out=()
  case "$path|$prev" in
${choiceCases.replace(/words=\(/g, "words_out=(") || '    "|") ;;'}
  esac
  if (( \${#words_out} )); then
    _describe 'value' words_out
    return
  fi

  words_out=()
  case "$path" in
${cases.replace(/words=\(/g, "words_out=(")}
  esac

  _describe 'command' words_out
}

_money_completion "$@"
`;
}

/**
 * Fish: one `complete` line per node, guarded by which subcommands have already
 * been seen. No path walking — fish's own predicates do it.
 */
function fish(tree: Node[], names: string[]): string {
  const lines = names.flatMap((name) =>
    tree.flatMap((node) => {
      // A node one level deep is guarded by its parent; the root is guarded by
      // there being no subcommand yet.
      const condition =
        node.path.length === 0
          ? `-n "not __fish_seen_subcommand_from ${tree
              .filter((n) => n.path.length === 1)
              .map((n) => n.path[0])
              .join(" ")}"`
          : `-n "__fish_seen_subcommand_from ${node.path.join(" ")}"`;

      const offered = [
        ...node.subcommands.map((sub) => `-a ${sub}`),
        ...node.flags.filter((flag) => flag !== "--help").map((flag) => `-l ${flag.slice(2)}`),
        ...node.choices.flatMap((choice) => [`-l ${choice.flag.slice(2)} -a "${choice.values.join(" ")}"`]),
      ];

      return offered.map((offer) => `complete -c ${name} -f ${condition} ${offer}`);
    }),
  );

  return `# money CLI completion (fish). Generated by \`money completion fish\`.
${lines.join("\n")}
`;
}
