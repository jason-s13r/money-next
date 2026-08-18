/**
 * Changes an existing user's display name.
 *
 *   money user rename --email me@example.com --name "Sam"
 *
 * The small sibling of `user password`, for the same reason: the in-app path
 * (`/account`) needs the person's own session, which an operator fixing their
 * account hasn't got. The usual case is a bootstrap account created with the
 * email in the `--name` slot, greeting them by their own address on every page.
 *
 * Unlike `user password`, this does not reach into Better Auth: `name` is a
 * plain column with no auth semantics hanging off it. Sessions are read from the
 * database every request, so a live one picks the new name up on its next render.
 *
 * Control-plane write (`User`): a person is not inside any one workspace, so
 * there is no `[workspace]` to scope this to.
 */
import { Command } from "commander";

import { normalizedEmail } from "../../lib/options";
import { onExit } from "../../runtime";

type Opts = { email: string; name: string };

export function register(parent: Command): void {
  parent
    .command("rename")
    .description("Change a display name")
    .requiredOption("--email <email>", "the account to rename", normalizedEmail)
    .requiredOption("--name <name>", "the new display name", (value: string) => value.trim())
    .addHelpText(
      "after",
      `
For an operator who cannot sign in as them — the in-app path (/account) needs
their session. The email address is the identifier and is not changed; that
stays at /account, where Better Auth owns the uniqueness check.
`,
    )
    .action(run);
}

async function run(opts: Opts) {
  const { authDb } = await import("../../../lib/server/db");
  onExit(() => authDb.$disconnect());

  const user = await authDb.user.findUnique({
    where: { email: opts.email },
    select: { id: true, name: true, email: true },
  });
  if (!user) throw new Error(`No user with ${opts.email}. See: money user list`);

  if (user.name === opts.name) {
    // Said, not silently succeeded — otherwise it reads the same as a rename
    // that worked, and the operator cannot tell they typed the old name.
    console.log(`${user.email} is already named "${user.name}". Nothing to do.`);
    return;
  }

  await authDb.user.update({ where: { id: user.id }, data: { name: opts.name } });

  console.log(`Renamed ${user.email}: "${user.name}" → "${opts.name}".`);
}
