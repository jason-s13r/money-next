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
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { auth } from "../lib/server/auth";
import { authDb } from "../lib/server/db";
import { BOOTSTRAP_WORKSPACE_ID } from "../lib/server/tenancy";

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

/**
 * Ask for the password twice, without echoing it.
 *
 * One readline interface for both prompts, which matters more than it looks: a
 * fresh interface per prompt buffers whatever else was already on stdin and
 * throws it away, so the second prompt sees EOF, its promise never settles, and
 * node — with nothing left to wait for — exits 0 having done nothing. That is
 * silent success on a piped stdin and works fine on a terminal, which is the
 * worst possible combination.
 */
async function readPasswordTwice(): Promise<string> {
  // Refuse a non-terminal outright rather than misbehave on one. Reading a
  // masked password needs a tty, and without this the failure is the nastiest
  // kind: `echo hunter2 | pnpm user:create` prints the prompts, creates nothing,
  // and exits 0, because the question never settles and node has nothing left to
  // wait for. Silent success is worse than an error.
  if (!stdin.isTTY) {
    throw new Error(
      "This script asks for a password on the terminal, so it can't be piped or run " +
        "from CI. Run it interactively.",
    );
  }

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  // `readline` has no silent mode: mute the output stream while the answer is
  // typed, and put it back afterwards.
  const io = rl as unknown as { output?: { write: (chunk: string) => void } };
  const original = io.output?.write.bind(io.output);
  let muted = false;
  if (io.output && original) {
    io.output.write = (chunk: string) => {
      if (!muted) original(chunk);
    };
  }

  const ask = async (prompt: string) => {
    const answer = rl.question(prompt);
    muted = true;
    const value = await answer;
    muted = false;
    stdout.write("\n");
    return value;
  };

  try {
    const password = await ask("Password: ");
    const again = await ask("Again: ");
    if (password !== again) throw new Error("Passwords didn't match.");
    if (!password) throw new Error("A password is required.");
    return password;
  } finally {
    if (io.output && original) io.output.write = original;
    rl.close();
  }
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
