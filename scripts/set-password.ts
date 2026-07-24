/**
 * Sets an existing user's password, because when someone is truly locked out
 * nothing in the app can.
 *
 *   pnpm user:password --email me@example.com
 *
 * This is the counterpart to create-user.ts: the bootstrap tool, not the admin
 * one. The in-app reset paths all need *something* the locked-out person hasn't
 * got — the change-password form needs a live session, the reset link needs an
 * owner to generate it and someone to receive it. This needs neither. It is the
 * floor: shell access to the box the instance runs on. Use it for the first
 * owner (who has no owner above them to send a link), or when the reset link
 * flow itself is what's broken.
 *
 * Unlike the reset link, this sets the password *directly* — there is no bearer
 * token to hand off, because the authority here is already the strongest one the
 * system has. The new password is read from the terminal, never a flag, so it
 * stays out of shell history and the process list (same as create-user.ts).
 */
import { readPasswordTwice } from "./read-secret";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm user:password --email <email>

Sets a password directly, for someone with no session and nobody above them to
ask — the first owner, or when the reset-link flow itself is broken. The
password is prompted for, never passed as a flag. Minimum 12 characters.`;

function parseArgs(argv: string[]): { email: string } {
  const i = argv.indexOf("--email");
  const email = i === -1 ? undefined : argv[i + 1];
  if (!email) throw new Error(USAGE);
  return { email };
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

  const { email } = parseArgs(process.argv.slice(2));

  const { auth } = await import("../lib/server/auth");
  const { authDb } = await import("../lib/server/db");
  disconnect = () => authDb.$disconnect();

  const user = await authDb.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) {
    throw new Error(`No user with ${email}. Create one first with \`pnpm user:create\`.`);
  }

  const password = await readPasswordTwice({ first: "New password: ", second: "Again: " });
  if (password.length < 12) {
    // The same floor the app enforces (lib/server/auth). Checked here too so the
    // failure is a clear message rather than a hash of a password too short to use.
    throw new Error("Password must be at least 12 characters.");
  }

  // Better Auth owns hashing, and there is no *public* API to set a password
  // without either a session or a reset token — the two things a locked-out
  // person lacks. So this reaches for the same context primitives Better Auth's
  // own `/reset-password` endpoint uses: `password.hash`, and the credential
  // account it hangs the hash on. The hashing stays the library's; only the
  // authority to invoke it is ours, and it is shell access.
  const ctx = await auth.$context;
  const hashed = await ctx.password.hash(password);

  const accounts = await ctx.internalAdapter.findAccounts(user.id);
  const credential = accounts.find((account) => account.providerId === "credential");
  if (credential) {
    await ctx.internalAdapter.updatePassword(user.id, hashed);
  } else {
    // A user created without a password (an OAuth-only account, were this
    // instance to grow one) gets a credential minted now.
    await ctx.internalAdapter.createAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: hashed,
    });
  }

  console.log(`Password set for ${user.email}. Any other sessions keep working — sign them out separately if that matters.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // This script owns its process, so it owns the disconnect — but only if a
    // client was ever opened. (A server action must never do this — see
    // docs/multi-user.md.)
    await disconnect?.();
  });
