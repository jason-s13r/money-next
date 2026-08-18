/**
 * Creates a user, because nothing else can.
 *
 *   money user create --email me@example.com --name "Sam"
 *   money user create --email them@example.com --name "Alex" --workspace personal --role editor
 *
 * Registration is invite-only and an invite must be sent by an owner, so the
 * first account cannot come from the app — there is nobody to invite it. Everyone
 * after the first should arrive through an invite link instead.
 *
 * `--workspace` is optional, and that is what keeps the bootstrap acyclic: a user
 * needs no workspace, a workspace needs a user, nothing needs both. An account
 * with no membership can sign in and land nowhere, which `money user list` flags.
 *
 * The password is read from the terminal rather than taken as a flag, so it does
 * not reach shell history or the process list.
 */
import { Command, Option } from "commander";

import { ROLES, type Role } from "../../../lib/server/auth/roles";
import { addMembership, resolveWorkspace } from "../../lib/membership";
import { normalizedEmail } from "../../lib/options";
import { readPasswordTwice } from "../../lib/read-secret";
import { onExit } from "../../runtime";

type Opts = { email: string; name: string; workspace?: string; role?: Role };

export function register(parent: Command): void {
  parent
    .command("create")
    .description("Create an account. The only way one comes into being")
    .requiredOption("--email <email>", "the address they sign in with", normalizedEmail)
    .requiredOption("--name <name>", "display name")
    .option("--workspace <slug|id>", "optionally place them in a workspace straight away")
    .addOption(
      new Option("--role <role>", "how, when placed in one")
        .choices([...ROLES])
        // Least privilege when unstated: an unasked-for role should be the one
        // that can read and change nothing.
        .default("viewer"),
    )
    .addHelpText(
      "after",
      `
Omit --workspace and the account exists with no membership — fine, and the
normal shape when the workspace does not exist yet:

  money user create --email me@example.com --name "Sam"
  money workspace create --name "Personal" --owner me@example.com
`,
    )
    .action(run);
}

async function run(opts: Opts, command: Command) {
  // The *source*, not the value: a default `viewer` is indistinguishable from a
  // typed `--role viewer` in `opts`. Silently ignoring it would leave someone
  // believing they created an owner.
  if (opts.workspace === undefined && command.getOptionValueSource("role") === "cli") {
    throw new Error("--role only means something with --workspace.");
  }

  const { auth } = await import("../../../lib/server/auth");
  const { authDb } = await import("../../../lib/server/db");
  onExit(() => authDb.$disconnect());

  const existing = await authDb.user.findUnique({ where: { email: opts.email } });
  if (existing) throw new Error(`A user with ${opts.email} already exists.`);

  // Before the account is created, so a mistyped slug fails with nothing
  // written — the other order leaves an orphan behind a reported failure.
  const workspace = opts.workspace ? await resolveWorkspace(opts.workspace) : null;

  const password = await readPasswordTwice();

  // Better Auth's own API rather than an insert: it owns the hashing, and a row
  // written here would be a second definition of what a credential is.
  const { user } = await auth.api.signUpEmail({
    body: { email: opts.email, name: opts.name, password },
  });
  console.log(`Created ${user.email} (${user.id}).`);

  if (!workspace) {
    console.log("No workspace membership. Either:");
    console.log(`  money workspace create --name "<name>" --owner ${user.email}`);
    console.log(`  money workspace add-member --workspace <slug> --email ${user.email} --role <role>`);
    return;
  }

  const role = opts.role ?? "viewer";
  await addMembership({ workspaceId: workspace.id, userId: user.id, role });
  console.log(`${role} of "${workspace.name}" — /w/${workspace.slug}`);
}
