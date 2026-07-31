/**
 * Changes an existing user's display name.
 *
 *   pnpm user:rename --email me@example.com --name "Sam"
 *
 * The small sibling of `user:password`, and for the same reason: there is one
 * in-app path (`/account`, while signed in) and it needs the thing an operator
 * fixing somebody else's account hasn't got — that person's session. The usual
 * case is a bootstrap account created with the email in the `--name` slot, which
 * then greets them by their own address on every page. Fixing that should not
 * require resetting their password to borrow their session.
 *
 * Unlike `user:password`, this does not reach into Better Auth. `name` is a
 * plain column with no auth semantics — nothing derives from it, no credential
 * hangs off it, and `auth.api.updateUser` writes exactly this column after
 * checking a session (see app/account/actions.ts). Sessions are read from the
 * database on every request (no `session.cookieCache` in lib/server/auth), so a
 * live session picks the new name up on its next render with nothing to
 * invalidate. Borrowing the library's internals to write one string would buy
 * nothing and claim the column is the library's, which it isn't.
 *
 * Control-plane write (`User`): a person is not inside any one workspace, and
 * there is no `[workspace]` to scope this to. No financial data is touched.
 */

// See the note in list-workspaces.ts: every import here is dynamic, and a file
// with no static import or export is not a module.
export {};
import { runScript } from "./_bootstrap";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm user:rename --email <email> --name "<new name>"

Sets the display name on an existing account, for an operator who cannot sign in
as them — the in-app path (/account) needs their session. The email address is
the identifier and is not changed; that stays at /account, where Better Auth owns
the uniqueness check.`;

function parseArgs(argv: string[]): { email: string; name: string } {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const email = flag("email");
  const name = flag("name")?.trim();
  if (!email || !name) throw new Error(USAGE);
  return { email, name };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const args = parseArgs(process.argv.slice(2));

  const { authDb } = await import("../lib/server/db");
  disconnect = () => authDb.$disconnect();

  const user = await authDb.user.findUnique({
    where: { email: args.email },
    select: { id: true, name: true, email: true },
  });
  if (!user) throw new Error(`No user with ${args.email}. See: pnpm user:list`);

  if (user.name === args.name) {
    // Said rather than written. A silent success here reads as "the rename
    // worked", which is indistinguishable from having typed the old name.
    console.log(`${user.email} is already named "${user.name}". Nothing to do.`);
    return;
  }

  await authDb.user.update({ where: { id: user.id }, data: { name: args.name } });

  console.log(`Renamed ${user.email}: "${user.name}" → "${args.name}".`);
}

runScript(main, () => disconnect?.());
