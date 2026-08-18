/**
 * Gets an existing user back into their account, because when someone is truly
 * locked out nothing in the app can.
 *
 *   money user password --email me@example.com
 *   money user password --email them@example.com --send-email
 *
 * Every in-app reset path needs something the locked-out person hasn't got: the
 * change-password form needs a live session, the reset link needs an owner to
 * generate it. This needs neither — the authority is shell access to the box.
 *
 * The two modes are not the same power. By default the password is set directly,
 * read from the terminal so it stays out of shell history and the process list;
 * the cost is that the operator then knows a password the holder uses.
 * `--send-email` mints the same link `/w/<slug>/members` does, so they choose
 * their own and the operator never learns it — weaker in every respect (an hour,
 * single-use, useless unless they can read their mail), and so the one to prefer.
 */
import { Command } from "commander";

import { normalizedEmail } from "../../lib/options";
import { readPasswordTwice } from "../../lib/read-secret";
import { onExit } from "../../runtime";

type Opts = { email: string; sendEmail?: boolean };

export function register(parent: Command): void {
  parent
    .command("password")
    .description("Set a password, or email a reset link, for someone locked out")
    .requiredOption("--email <email>", "the account to let back in", normalizedEmail)
    .option("--send-email", "email them a reset link instead of setting a password here")
    .addHelpText(
      "after",
      `
Without --send-email the password is prompted for (never passed as a flag,
minimum 12 characters) and set directly — for someone with no session and
nobody above them to ask, or when the reset-link flow itself is broken.

With it, nothing changes until they use the link: it expires in an hour, works
once, and means the operator never knows their password. Prefer it for anyone
who isn't you.
`,
    )
    .action(run);
}

async function run(opts: Opts) {
  const { auth } = await import("../../../lib/server/auth");
  const { authDb } = await import("../../../lib/server/db");
  onExit(() => authDb.$disconnect());

  const user = await authDb.user.findUnique({
    where: { email: opts.email },
    select: { id: true, email: true },
  });
  if (!user) {
    throw new Error(`No user with ${opts.email}. Create one first with \`money user create\`.`);
  }

  if (opts.sendEmail) {
    await sendResetLink(user.email);
    return;
  }

  const password = await readPasswordTwice({ first: "New password: ", second: "Again: " });
  // The same floor the app enforces, checked here so the failure is a message
  // rather than a hash of a password too short to use.
  if (password.length < 12) {
    throw new Error("Password must be at least 12 characters.");
  }

  // No public API sets a password without a session or a reset token — the two
  // things a locked-out person lacks. So this uses the same context primitives
  // Better Auth's own `/reset-password` endpoint does. The hashing stays the
  // library's; only the authority to invoke it is ours.
  const ctx = await auth.$context;
  const hashed = await ctx.password.hash(password);

  const accounts = await ctx.internalAdapter.findAccounts(user.id);
  const credential = accounts.find((account) => account.providerId === "credential");
  if (credential) {
    await ctx.internalAdapter.updatePassword(user.id, hashed);
  } else {
    // An account with no password yet (OAuth-only, were this instance to grow
    // one) gets a credential minted now.
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
 * `withResetTokenCapture` both hands back the token — the endpoint exposes it to
 * nothing but its delivery callback — and *permits* the mail, since
 * `sendResetPassword` queues only when a capture is open. That is what stops a
 * bare POST to the public endpoint becoming a forgot-password flow.
 */
async function sendResetLink(email: string) {
  const { auth } = await import("../../../lib/server/auth");
  const { withResetTokenCapture } = await import("../../../lib/server/auth/reset-capture");
  const { emailEnabled } = await import("../../../lib/server/email/config");
  const { resetUrl } = await import("../../../lib/server/email/messages");

  const token = await withResetTokenCapture(() =>
    auth.api.requestPasswordReset({ body: { email } }),
  );

  // The endpoint is enumeration-resistant, so it swallows its failures. The
  // account was found a moment ago, which leaves misconfiguration.
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
    console.log("Delivery is the worker's: check `money email list` if it doesn't arrive.");
  }
}
