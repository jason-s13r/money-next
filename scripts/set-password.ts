/**
 * Gets an existing user back into their account, because when someone is truly
 * locked out nothing in the app can.
 *
 *   pnpm user:password --email me@example.com
 *   pnpm user:password --email them@example.com --send-email
 *
 * This is the counterpart to create-user.ts: the bootstrap tool, not the admin
 * one. The in-app reset paths all need *something* the locked-out person hasn't
 * got — the change-password form needs a live session, the reset link needs an
 * owner to generate it and someone to receive it. This needs neither. It is the
 * floor: shell access to the box the instance runs on. Use it for the first
 * owner (who has no owner above them to send a link), or when the reset link
 * flow itself is what's broken.
 *
 * ## Two ways, and they are not the same power
 *
 * By default this sets the password *directly* — no bearer token to hand off,
 * because the authority here is already the strongest the system has. It is read
 * from the terminal, never a flag, so it stays out of shell history and the
 * process list (same as create-user.ts). The cost is that the operator now knows
 * a password the account holder uses, and has to relay it somehow.
 *
 * `--send-email` mints the same reset link `/w/<slug>/members` does and emails
 * it, so they choose their own password and the operator never learns it. It is
 * the weaker capability in every respect — an hour, single-use, useless unless
 * they can read their mail — which is why it is the one to prefer.
 */
import { readPasswordTwice } from "./read-secret";
import { runScript } from "./_bootstrap";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm user:password --email <email>
  pnpm user:password --email <email> --send-email

  --email       the account to let back in
  --send-email  email them a reset link instead of setting a password here

Without --send-email the password is prompted for (never passed as a flag,
minimum 12 characters) and set directly — for someone with no session and
nobody above them to ask, or when the reset-link flow itself is broken.

With it, nothing changes until they use the link: it expires in an hour, works
once, and means the operator never knows their password. Prefer it for anyone
who isn't you.`;

type Args = { email: string; sendEmail: boolean };

function parseArgs(argv: string[]): Args {
  const i = argv.indexOf("--email");
  const email = i === -1 ? undefined : argv[i + 1];
  if (!email) throw new Error(USAGE);
  // Addresses are stored lowercased; `--email SAM@…` would otherwise report an
  // account that plainly exists as missing.
  return { email: email.toLowerCase(), sendEmail: argv.includes("--send-email") };
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

  const user = await authDb.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) {
    throw new Error(`No user with ${args.email}. Create one first with \`pnpm user:create\`.`);
  }

  if (args.sendEmail) {
    await sendResetLink(user.email);
    return;
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

/**
 * Mint a reset link and queue the mail carrying it.
 *
 * `requestPasswordReset` needs no headers — no session middleware, only an
 * origin check on a `redirectTo` that isn't passed.
 *
 * `withResetTokenCapture` both hands back the token (the endpoint exposes it to
 * nothing but its own delivery callback) and *permits* the mail:
 * `sendResetPassword` queues only when a capture is open, so a bare POST to the
 * public endpoint cannot become a forgot-password flow nobody built a form for.
 */
async function sendResetLink(email: string) {
  const { auth } = await import("../lib/server/auth");
  const { withResetTokenCapture } = await import("../lib/server/auth/reset-capture");
  const { emailEnabled } = await import("../lib/server/email/config");
  const { resetUrl } = await import("../lib/server/email/messages");

  const token = await withResetTokenCapture(() =>
    auth.api.requestPasswordReset({ body: { email } }),
  );

  // Enumeration-resistant, so it swallows its failures: a null token means none
  // was minted. The account was found a moment ago, leaving misconfiguration.
  if (!token) {
    throw new Error(`No reset link was generated for ${email}. Password reset looks misconfigured.`);
  }

  // "Queued", not "sent": this process only writes the outbox row, and the
  // worker that talks to the relay may not be running.
  console.log(
    emailEnabled()
      ? `Queued a reset link for ${email}. It expires in an hour and works once.`
      : `SMTP is not configured, so nothing was emailed. Send them this link — it ` +
          `expires in an hour and works once:`,
  );
  console.log(`  ${resetUrl(token)}`);

  if (emailEnabled()) {
    console.log();
    console.log("Delivery is the worker's: check `pnpm email:list` if it doesn't arrive.");
  }
}

runScript(main, () => disconnect?.());
