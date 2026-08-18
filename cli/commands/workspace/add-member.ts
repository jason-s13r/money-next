/**
 * Puts someone into a workspace — directly, or by inviting them.
 *
 *   money workspace add-member --workspace <slug|id> --email <email> --role editor
 *   money workspace add-member --workspace <slug|id> --email <email> --role editor --invite
 *
 * Without `--invite` the account must exist and is placed straight away — the
 * operator's path, for testing or a second member without two browsers.
 *
 * `--invite` emails the same invitation `/w/<slug>/members` sends, so they pick
 * their own password and nothing is relayed by hand; the account need not exist,
 * since the invite page mints it. The ordinary path for a person.
 *
 * Adds only, hence `add-member` rather than `member` — removal and role changes
 * are deliberately absent, for the reason on `addMembership`.
 */
import { Command, Option } from "commander";

import { ROLES, type Role } from "../../../lib/server/auth/roles";
import { addMembership, currentRole, resolveWorkspace } from "../../lib/membership";
import { sendInvite } from "../../lib/invite";
import { normalizedEmail } from "../../lib/options";
import { onExit } from "../../runtime";

type Opts = { workspace: string; email: string; role: Role; invite?: boolean; name?: string };

export function register(parent: Command): void {
  parent
    .command("add-member")
    .description("Add someone to a workspace, outright or by emailing an invite")
    .requiredOption("--workspace <slug|id>", "the workspace they are joining")
    .requiredOption("--email <email>", "the address they sign in with", normalizedEmail)
    .addOption(new Option("--role <role>", "what they may do in it").choices([...ROLES]).makeOptionMandatory())
    .option("--invite", "email them an invitation instead of adding them outright")
    .option("--name <name>", "pre-fills the signup form (only with --invite)")
    .addHelpText(
      "after",
      `
Without --invite the account must already exist and is added immediately. With
it, an invitation is emailed and the membership appears when they accept — the
account is created then if they haven't got one, so they pick their own
password. Invitations expire in three days; re-running this re-sends a live one
rather than issuing a second.

To change a role or remove someone, use /w/<slug>/members in the app — the
last-owner invariant lives there, in the library, and this command will not fork
it.
`,
    )
    .action(run);
}

async function run(opts: Opts) {
  if (opts.name && !opts.invite) {
    // Rather than ignoring it: the account exists and has a name, so this would
    // read as a rename and do nothing.
    throw new Error("--name only means something with --invite. To rename an account, use `money user rename`.");
  }

  const { authDb } = await import("../../../lib/server/db");
  onExit(() => authDb.$disconnect());

  const workspace = await resolveWorkspace(opts.workspace);

  const user = await authDb.user.findUnique({
    where: { email: opts.email },
    select: { id: true, name: true, email: true },
  });

  // Rather than leaving it to `@@unique([workspaceId, userId])`, which surfaces
  // as a Prisma error naming an index. Before the invite branch too — otherwise
  // they find out from the acceptance page days later.
  const existing = user ? await currentRole(workspace.id, user.id) : null;
  if (existing) {
    throw new Error(
      `${opts.email} is already ${existing} of "${workspace.name}". ` +
        `Change it at /w/${workspace.slug}/members.`,
    );
  }

  if (opts.invite) {
    const invite = await sendInvite({
      workspace,
      email: opts.email,
      role: opts.role,
      name: opts.name,
    });

    console.log(
      invite.resent
        ? `${opts.email} already had a pending invitation to "${workspace.name}" — sent it again.`
        : `Invited ${opts.email} to "${workspace.name}" as ${opts.role}. Expires in 3 days.`,
    );

    // Not a secret on its own — accepting requires the address it names — so it
    // is printed either way and may be handed over directly.
    console.log(`  ${invite.url}`);
    if (!invite.queued) {
      console.log();
      console.log("SMTP is not configured, so nothing was emailed. Send them that link.");
    }
    if (!user) {
      console.log(`No account for ${opts.email} yet; opening the link creates one.`);
    }
    return;
  }

  if (!user) {
    throw new Error(
      `No user with ${opts.email}. Either invite them:\n` +
        `  money workspace add-member --workspace ${workspace.slug} --email ${opts.email} ` +
        `--role ${opts.role} --invite\n` +
        `or create the account yourself first:\n` +
        `  money user create --email ${opts.email} --name "<name>" ` +
        `--workspace ${workspace.slug} --role ${opts.role}`,
    );
  }

  await addMembership({ workspaceId: workspace.id, userId: user.id, role: opts.role });

  console.log(`${user.name} <${user.email}> is now ${opts.role} of "${workspace.name}"`);
  console.log(`  /w/${workspace.slug}`);
}
