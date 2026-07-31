/**
 * Who has an account on this instance, and what they can reach.
 *
 *   pnpm user:list
 *
 * The companion to `workspace:list`, which answers the same question from the
 * other side. Both exist because neither is answerable from the app: a person
 * signed into the app sees the workspaces *they* belong to, by design, and there
 * is no site-admin surface that sees the rest.
 *
 * The row this makes visible, and the reason it is worth a script rather than a
 * `psql` one-liner, is the user with no memberships. That is exactly what
 * `pnpm user:create` without `--owner` leaves behind, and what remains after a
 * workspace is deleted — an account that can sign in and land nowhere. It is
 * invisible in `workspace:list` because it is in no workspace.
 *
 * Control-plane read (`User`, `Membership`, `Workspace`): these decide tenancy
 * rather than being scoped by it, so spanning workspaces is the correct
 * behaviour here. No financial data is touched.
 */

// See the note in list-workspaces.ts: every import here is dynamic, and a file
// with no static import or export is not a module.
export {};
import { runScript } from "./_bootstrap";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm user:list

Lists every account with its workspace memberships and roles, and flags the
ones with no membership and no second factor.`;

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const { authDb } = await import("../lib/server/db");
  disconnect = () => authDb.$disconnect();

  const users = await authDb.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      twoFactorEnabled: true,
      createdAt: true,
      memberships: {
        select: { role: true, workspace: { select: { slug: true } } },
        orderBy: { workspace: { name: "asc" } },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (users.length === 0) {
    console.log("No users. Create the first one:");
    console.log('  pnpm user:create --email <email> --name "<name>" --owner');
    return;
  }

  for (const user of users) {
    // `twoFactorEnabled` says whether TOTP is *enrolled*, not whether it is
    // required — that is REQUIRE_MFA, a flag rather than a column (phase 3).
    // Shown because Akahu accreditation makes enrolment mandatory, so this is
    // the list that has to be empty of "no mfa" before that flag can be flipped.
    const mfa = user.twoFactorEnabled ? "mfa" : "no mfa";
    console.log(`${user.name} <${user.email}>  [${mfa}]  (${user.id})`);

    if (user.memberships.length === 0) {
      console.log("  no workspaces — can sign in, lands nowhere");
    } else {
      for (const m of user.memberships) {
        console.log(`  ${m.role.padEnd(7)} /w/${m.workspace.slug}`);
      }
    }
  }
}

runScript(main, () => disconnect?.());
