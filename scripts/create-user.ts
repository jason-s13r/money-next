/**
 * Creates a user, because nothing else can.
 *
 *   pnpm user:create --email me@example.com --name "Sam"
 *   pnpm user:create --email them@example.com --name "Alex" --workspace personal --role editor
 *
 * Registration is invite-only and an invite has to be *sent* by an owner of a
 * workspace, so the very first account cannot come from the app: there is nobody
 * to invite it. That is the whole reason this exists. Everyone after the first
 * should arrive through an invite link instead.
 *
 * ## The bootstrap order, and the cycle that used to be in it
 *
 * `--workspace` is optional and a user with no membership is a legitimate state
 * — they can sign in and land nowhere until someone adds them, which is what
 * `pnpm user:list` flags. That optionality is what makes the bootstrap acyclic:
 *
 *     pnpm user:create --email me@example.com --name "Sam"
 *     pnpm workspace:create --name "Personal" --owner me@example.com
 *
 * A user needs no workspace; a workspace needs a user; nothing needs both.
 *
 * This script used to carry a `--owner` flag instead, which made the new account
 * an owner of `BOOTSTRAP_WORKSPACE_ID` — a workspace inserted by the
 * `tenancy_models` migration. That existed only because a workspace could not be
 * created any other way, so at bootstrap a workspace preceded every user and the
 * dependency ran backwards. `pnpm workspace:create` removed the reason, the flag
 * went with it, and `lib/server/tenancy.ts` went with the flag — it had no other
 * caller. Phase 3 said it would delete that file; this is it.
 *
 * The password is read from the terminal rather than taken as a flag, so it
 * doesn't end up in shell history or in the process list.
 */
import { ROLES, isRole, type Role } from "../lib/server/auth/roles";
import { addMembership, resolveWorkspace } from "./membership";
import { readPasswordTwice } from "./read-secret";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm user:create --email <email> --name "<name>" [--workspace <slug|id>] [--role <role>]

  --email      the address they sign in with
  --name       display name
  --workspace  optionally place them in a workspace straight away
  --role       ${ROLES.join(" | ")} (default: viewer; only with --workspace)

Omit --workspace and the account exists with no membership — fine, and the
normal shape when the workspace does not exist yet:

  pnpm user:create --email me@example.com --name "Sam"
  pnpm workspace:create --name "Personal" --owner me@example.com`;

type Args = { email: string; name: string; workspace?: string; role: Role };

function parseArgs(argv: string[]): Args {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const email = flag("email");
  const name = flag("name");
  if (!email || !name) throw new Error(USAGE);

  const workspace = flag("workspace");
  const role = flag("role");

  if (role && !workspace) {
    // Rather than silently ignoring it. A `--role owner` that did nothing is a
    // person who believes they created an owner and did not.
    throw new Error("--role only means something with --workspace.");
  }
  if (role && !isRole(role)) {
    throw new Error(`--role must be one of ${ROLES.join(", ")} (got "${role}").`);
  }

  // Least privilege when unstated: an unasked-for role should be the one that
  // can read and change nothing.
  return { email, name, workspace, role: (role as Role | undefined) ?? "viewer" };
}

async function main() {
  // Before the imports below, deliberately. `lib/server/auth` builds its client
  // at module scope and throws if BETTER_AUTH_SECRET is unset, so a static
  // import would make `--help` fail on exactly the machine whose operator most
  // needs to read it.
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const args = parseArgs(process.argv.slice(2));

  const { auth } = await import("../lib/server/auth");
  const { authDb } = await import("../lib/server/db");
  disconnect = () => authDb.$disconnect();

  const existing = await authDb.user.findUnique({ where: { email: args.email } });
  if (existing) throw new Error(`A user with ${args.email} already exists.`);

  // Resolved *before* the account is created, so a mistyped slug fails with
  // nothing written. The other order leaves an account behind that the operator
  // then has to notice and clean up, having been told the command failed.
  const workspace = args.workspace ? await resolveWorkspace(args.workspace) : null;

  const password = await readPasswordTwice();

  // Through Better Auth's own API rather than a direct insert: it owns the
  // hashing, and a row this script wrote by hand would be a second, divergent
  // definition of what a credential is.
  const { user } = await auth.api.signUpEmail({
    body: { email: args.email, name: args.name, password },
  });
  console.log(`Created ${user.email} (${user.id}).`);

  if (!workspace) {
    console.log("No workspace membership. Either:");
    console.log(`  pnpm workspace:create --name "<name>" --owner ${user.email}`);
    console.log(`  pnpm workspace:member --workspace <slug> --email ${user.email} --role <role>`);
    return;
  }

  await addMembership({ workspaceId: workspace.id, userId: user.id, role: args.role });
  console.log(`${args.role} of "${workspace.name}" — /w/${workspace.slug}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // This script owns its process, so it owns the disconnect. (A server action
    // must never do this — see docs/multi-user.md.)
    await disconnect?.();
  });
