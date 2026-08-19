/**
 * `money` — admin operations for a running instance.
 *
 *   money user create --email you@example.com --name "Sam"
 *   money workspace list
 *   money link token --list
 *
 * Every command here is something the app deliberately cannot do: create the
 * first account, mint a tenant, store an Akahu token, let someone back in who
 * has no session. The authority for all of it is shell access to the box, which
 * is why they are commands and not pages.
 *
 * ## The one rule for a command module
 *
 * **Never import `lib/server/db` or `lib/server/auth` statically.** Both throw at
 * module scope without `DATABASE_URL` / `BETTER_AUTH_SECRET`, and this tree is
 * walked in full while the program is built — so one static import makes
 * `money --help` fail on the machine whose operator is reading it. Import them
 * inside the action instead. tests/cli.test.ts fences this.
 *
 * Building the program stays side-effect free so `money completion` and the
 * tests can walk the tree without running anything.
 */
import { Command } from "commander";

import { register as completion } from "./commands/completion";
import { register as email } from "./commands/email";
import { register as link } from "./commands/link";
import { register as reindexSyncRuns } from "./commands/reindex-sync-runs";
import { register as sync } from "./commands/sync";
import { register as unhookBootstrapIds } from "./commands/unhook-bootstrap-ids";
import { register as user } from "./commands/user";
import { register as workspace } from "./commands/workspace";

export function buildProgram(): Command {
  const program = new Command("money")
    .description("Admin operations for a running instance")
    // Registration order, not sorted, so the help tells the bootstrap story:
    // accounts, then tenants, then the bank, then the queues.
    .configureHelp({ sortSubcommands: false, sortOptions: false })
    .showHelpAfterError();

  user(program);
  workspace(program);
  link(program);
  email(program);
  sync(program);
  unhookBootstrapIds(program);
  reindexSyncRuns(program);
  completion(program);

  // Bare `money` prints the help rather than Commander's "missing command"
  // error — it has to be the thing you can type from memory.
  program.action(() => program.help());

  return program;
}
