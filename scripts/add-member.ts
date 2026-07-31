/**
 * Puts an existing user into an existing workspace.
 *
 *   pnpm workspace:member --workspace <slug|id> --email <email> --role editor
 *
 * The third of the three ways a membership comes to exist, and the one for the
 * case the other two do not cover:
 *
 *   - `pnpm workspace:create --owner <email>` — the first owner, at the moment
 *     the workspace is created.
 *   - `pnpm user:create --workspace <slug>` — a brand-new account, placed as it
 *     is minted.
 *   - this — an account that already exists, joining a workspace that already
 *     exists, without an owner being available to send an invite.
 *
 * The ordinary path for a person is still an invite link from `/w/<slug>/members`.
 * This is for the operator, and mostly for testing: it is how a second workspace
 * gets a second member without two people and two browsers.
 *
 * Adds only. Removing a member and changing a role are deliberately not here —
 * see the note on `addMembership` in ./membership for why the last-owner
 * invariant is not something a script gets to have its own copy of.
 */
import { ROLES, isRole, type Role } from "../lib/server/auth/roles";
import { addMembership, currentRole, resolveWorkspace } from "./membership";
import { runScript } from "./_bootstrap";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm workspace:member --workspace <slug|id> --email <email> --role <${ROLES.join("|")}>

Adds an existing user to an existing workspace. To change a role or remove
someone, use /w/<slug>/members in the app — the last-owner invariant lives
there, in the library, and this script will not fork it.`;

type Args = { workspace: string; email: string; role: Role };

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

  return { workspace, email, role };
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
  if (!user) {
    throw new Error(
      `No user with ${args.email}. Create them first, in one step:\n` +
        `  pnpm user:create --email ${args.email} --name "<name>" ` +
        `--workspace ${workspace.slug} --role ${args.role}`,
    );
  }

  // Checked here rather than left to `@@unique([workspaceId, userId])`, because
  // a constraint violation surfaces as a Prisma error naming an index, and what
  // the person running this needs to know is that the role they meant to set is
  // not the role that is set.
  const existing = await currentRole(workspace.id, user.id);
  if (existing) {
    throw new Error(
      `${user.email} is already ${existing} of "${workspace.name}". ` +
        `Change it at /w/${workspace.slug}/members.`,
    );
  }

  await addMembership({ workspaceId: workspace.id, userId: user.id, role: args.role });

  console.log(`${user.name} <${user.email}> is now ${args.role} of "${workspace.name}"`);
  console.log(`  /w/${workspace.slug}`);
}

runScript(main, () => disconnect?.());
