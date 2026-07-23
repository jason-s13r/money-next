/**
 * Creates a user, because nothing else can.
 *
 *   pnpm user:create --email me@example.com --name "Jason"
 *   pnpm user:create --email me@example.com --name "Jason" --owner
 *
 * Registration is invite-only and an invite has to be *sent* by an owner of a
 * workspace, so the very first account cannot come from the app: there is nobody
 * to invite it. That is the whole reason this exists. Everyone after the first
 * should arrive through an invite link instead — this script is the bootstrap,
 * not the admin tool.
 *
 * `--owner` also makes the new user an owner of the default workspace (the one
 * the existing financial data was backfilled to). Note the default workspace is
 * itself a transitional idea: it exists because the Akahu token in env belongs
 * to exactly one tenant. An instance where everyone connects their own bank has
 * no default workspace and this flag goes unused.
 *
 * The password is read from the terminal rather than taken as a flag, so it
 * doesn't end up in shell history or in the process list.
 */
import { auth } from "../lib/server/auth";
import { authDb } from "../lib/server/db";
import { BOOTSTRAP_WORKSPACE_ID } from "../lib/server/tenancy";
import { readPasswordTwice } from "./read-password";

type Args = { email: string; name: string; owner: boolean };

function parseArgs(argv: string[]): Args {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const email = flag("email");
  const name = flag("name");
  if (!email || !name) {
    throw new Error(
      'Usage: pnpm user:create --email <email> --name "<name>" [--owner]\n' +
        "  --owner  also make them an owner of the default workspace",
    );
  }
  return { email, name, owner: argv.includes("--owner") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const existing = await authDb.user.findUnique({ where: { email: args.email } });
  if (existing) throw new Error(`A user with ${args.email} already exists.`);

  const password = await readPasswordTwice();

  // Through Better Auth's own API rather than a direct insert: it owns the
  // hashing, and a row this script wrote by hand would be a second, divergent
  // definition of what a credential is.
  const { user } = await auth.api.signUpEmail({
    body: { email: args.email, name: args.name, password },
  });
  console.log(`Created ${user.email} (${user.id}).`);

  if (!args.owner) {
    console.log("No workspace membership — invite them to one, or re-run with --owner.");
    return;
  }

  const workspace = await authDb.workspace.findUnique({
    where: { id: BOOTSTRAP_WORKSPACE_ID },
    select: { id: true, slug: true, name: true },
  });
  if (!workspace) {
    throw new Error(
      `The default workspace (${BOOTSTRAP_WORKSPACE_ID}) is missing. It is created by the ` +
        "tenancy_models migration — has `prisma migrate deploy` run?",
    );
  }

  await authDb.membership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "owner" },
  });
  console.log(`Owner of "${workspace.name}" — /w/${workspace.slug}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // This script owns its process, so it owns the disconnect. (A server action
    // must never do this — see docs/multi-user.md.)
    await authDb.$disconnect();
  });
