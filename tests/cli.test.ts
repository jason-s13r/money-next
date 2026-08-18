import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";

import type { Command } from "commander";

import { buildProgram } from "../cli/program";

/**
 * The `money` CLI's structural guarantees — the parts no library enforces: that
 * the tree is fully described, that `--help` works on a machine with no
 * environment, and that completion covers everything.
 */

/** Every command in the tree, depth-first, as `["user", "create"]` paths. */
function walk(command: Command, path: string[] = []): { path: string[]; command: Command }[] {
  return command.commands.flatMap((child) => {
    const here = [...path, child.name()];
    // Commander's own `help` command is generated, not ours to describe.
    if (child.name() === "help") return [];
    return [{ path: here, command: child }, ...walk(child, here)];
  });
}

const program = buildProgram();
const all = walk(program);

describe("the command tree", () => {
  test("every command has a description", () => {
    const undescribed = all.filter(({ command }) => !command.description()).map(({ path }) => path.join(" "));

    assert.deepEqual(
      undescribed,
      [],
      `these commands have no .description(): ${undescribed.join(", ")}. It is what the ` +
        `parent's help lists them by, so an undescribed command is an invisible one.`,
    );
  });

  test("the groups people reach for are all there", () => {
    // A hand-written inventory: every other check here walks whatever tree it is
    // given, so a rename would slip through as a decision nobody made.
    const names = all.map(({ path }) => path.join(" "));

    for (const expected of [
      "user create", "user list", "user rename", "user password", "user delete",
      "workspace create", "workspace list", "workspace add-member", "workspace delete",
      "link token", "link keypair", "link upgrade",
      "email list", "email retry", "email clear-failed",
      "sync", "unhook-bootstrap-ids", "completion",
    ]) {
      assert.ok(names.includes(expected), `\`money ${expected}\` is gone — was that deliberate?`);
    }
  });
});

describe("--help on a machine with nothing configured", () => {
  // The property the cli/ layout protects. Fenced twice: the grep catches an
  // import the spawn would only notice once it is actually reached, and the
  // spawn catches anything the regex does not describe.

  test("no command module imports lib/server/db or lib/server/auth statically", () => {
    const root = new URL("..", import.meta.url).pathname;

    // `import type` is erased before it runs, hence the `[^t]`.
    let matches = "";
    try {
      matches = execFileSync(
        "git",
        [
          "grep", "-l", "-E", "--untracked",
          '^import [^t].*from "(\\.\\./)+lib/server/(db|auth)"',
          "--", "cli/*.ts", "cli/**/*.ts",
        ],
        { cwd: root, encoding: "utf8" },
      );
    } catch (error) {
      const { status, stdout } = error as { status?: number; stdout?: string };
      if (status !== 1) throw error;
      matches = stdout ?? "";
    }

    const offenders = matches.split("\n").filter(Boolean);

    assert.deepEqual(
      offenders,
      [],
      `these files import lib/server/db or lib/server/auth statically: ${offenders.join(", ")}. ` +
        `Both throw at module scope without their environment variables, so this breaks ` +
        `\`money --help\` on an unconfigured machine. Import them inside the action instead.`,
    );
  });

  test("`money --help` exits 0 with the environment stripped", () => {
    const root = new URL("..", import.meta.url).pathname;

    // The entry point rather than bin/money: the wrapper loads the repo's .env,
    // which would put back the variables this is removing.
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.BETTER_AUTH_SECRET;

    const help = execFileSync(
      process.execPath,
      ["--import", "tsx", "cli/index.ts", "--help"],
      { cwd: root, encoding: "utf8", env },
    );

    assert.match(help, /Admin operations for a running instance/);
  });
});

describe("shell completion", () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    test(`${shell} completion names every command`, () => {
      // The failure this catches is a command the *generator* cannot see, which
      // is silent — it would simply never complete.
      const script = capture(["completion", shell]);

      const missing = all
        .map(({ path }) => path[path.length - 1])
        .filter((name) => !script.includes(name));

      assert.deepEqual(missing, [], `${shell} completion is missing: ${missing.join(", ")}`);
    });
  }
});

/** Run the CLI in a child process and hand back what it wrote to stdout. */
function capture(args: string[]): string {
  const root = new URL("..", import.meta.url).pathname;
  return execFileSync(process.execPath, ["--import", "tsx", "cli/index.ts", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}
