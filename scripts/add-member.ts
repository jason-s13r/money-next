/**
 * Puts someone into a workspace — directly, or by inviting them.
 *
 *   pnpm workspace:member --workspace <slug|id> --email <email> --role editor
 *   pnpm workspace:member --workspace <slug|id> --email <email> --role editor --invite
 *
 * Without `--invite` the account has to exist already and is placed straight
 * away, which is the third of the three ways a membership comes to exist:
 *
 *   - `pnpm workspace:create --owner <email>` — the first owner, at the moment
 *     the workspace is created.
 *   - `pnpm user:create --workspace <slug>` — a brand-new account, placed as it
 *     is minted.
 *   - this — an account that already exists, joining a workspace that already
 *     exists, without an owner being available to send an invite.
 *
 * `--invite` emails the same invitation `/w/<slug>/members` sends, so they pick
 * their own password and nothing is relayed by hand; the account need not exist,
 * since the invite page mints it. That makes it the ordinary path for a person,
 * leaving the direct form to the operator — mostly testing, or a second member
 * without two browsers.
 *
 * Adds only. Removing a member and changing a role are deliberately not here —
 * see the note on `addMembership` in ./membership for why the last-owner
 * invariant is not something a script gets to have its own copy of.
 */
import { ROLES, isRole, type Role } from "../lib/server/auth/roles";
import { addMembership, currentRole, resolveWorkspace } from "./membership";
import { sendInvite } from "./invite";
import { runScript } from "./_bootstrap";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm workspace:member --workspace <slug|id> --email <email> --role <${ROLES.join("|")}> [--invite] [--name "<name>"]

  --workspace  slug or id of the workspace they are joining
  --email      the address they sign in with
  --role       ${ROLES.join(" | ")}
  --invite     email them an invitation instead of adding them outright
  --name       pre-fills the signup form (only with --invite)

Without --invite the account must already exist and is added immediately. With
it, an invitation is emailed and the membership appears when they accept — the
account is created then if they haven't got one, so they pick their own
password. Invitations expire in three days; re-running this re-sends a live one
rather than issuing a second.

To change a role or remove someone, use /w/<slug>/members in the app — the
last-owner invariant lives there, in the library, and this script will not fork
it.`;

type Args = { workspace: string; email: string; role: Role; invite: boolean; name?: string };

function parseArgs(argv: string[]): Args {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const workspace = flag("workspace");
  const email = flag("email");
  const role = flag("role");
  if (!workspace || !email || !role) throw new Error(USAGE);

  if (!isRole(role)) {
    throw new Error(`--role must be one of ${ROLES.join(", ")} (got "${role}").`);
  }

  const invite = argv.includes("--invite");
  const name = flag("name");

  if (name && !invite) {
    // Rather than ignoring it: the account already exists and has a name, so
    // this would read as a rename and do nothing.
    throw new Error("--name only means something with --invite. To rename an account, use `pnpm user:rename`.");
  }

  // Addresses are stored lowercased, so `--email SAM@…` finds no `User` row —
  // which on the invite path skips the already-a-member check below and issues a
  // second invitation to someone who is already in the workspace.
  return { workspace, email: email.toLowerCase(), role, invite, name };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const args = parseArgs(process.argv.slice(2));

  const { authDb } = await import("../lib/server/db");
  disconnect = () => authDb.$disconnect();

  const workspace = await resolveWorkspace(args.workspace);

  const user = await authDb.user.findUnique({
    where: { email: args.email },
    select: { id: true, name: true, email: true },
  });

  // Checked here rather than left to `@@unique([workspaceId, userId])`, because
  // a constraint violation surfaces as a Prisma error naming an index, and what
  // the person running this needs to know is that the role they meant to set is
  // not the role that is set. Before the invite branch too: otherwise they find
  // out from the acceptance page days later.
  const existing = user ? await currentRole(workspace.id, user.id) : null;
  if (existing) {
    throw new Error(
      `${args.email} is already ${existing} of "${workspace.name}". ` +
        `Change it at /w/${workspace.slug}/members.`,
    );
  }

  if (args.invite) {
    const invite = await sendInvite({
      workspace,
      email: args.email,
      role: args.role,
      name: args.name,
    });

    console.log(
      invite.resent
        ? `${args.email} already had a pending invitation to "${workspace.name}" — sent it again.`
        : `Invited ${args.email} to "${workspace.name}" as ${args.role}. Expires in 3 days.`,
    );

    // Printed either way: it is not a secret on its own (accepting requires
    // being signed in as the address it names) and may be handed over directly.
    console.log(`  ${invite.url}`);
    if (!invite.queued) {
      console.log();
      console.log("SMTP is not configured, so nothing was emailed. Send them that link.");
    }
    if (!user) {
      console.log(`No account for ${args.email} yet; opening the link creates one.`);
    }
    return;
  }

  if (!user) {
    throw new Error(
      `No user with ${args.email}. Either invite them:\n` +
        `  pnpm workspace:member --workspace ${workspace.slug} --email ${args.email} ` +
        `--role ${args.role} --invite\n` +
        `or create the account yourself first:\n` +
        `  pnpm user:create --email ${args.email} --name "<name>" ` +
        `--workspace ${workspace.slug} --role ${args.role}`,
    );
  }

  await addMembership({ workspaceId: workspace.id, userId: user.id, role: args.role });

  console.log(`${user.name} <${user.email}> is now ${args.role} of "${workspace.name}"`);
  console.log(`  /w/${workspace.slug}`);
}

runScript(main, () => disconnect?.());
