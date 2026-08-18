/**
 * Who has an account on this instance, and what they can reach.
 *
 *   money user list
 *
 * The companion to `workspace list`, from the other side. Neither is answerable
 * from the app: a signed-in person sees the workspaces *they* belong to, and
 * there is no site-admin surface that sees the rest.
 *
 * The row worth a command rather than a `psql` one-liner is the user with no
 * memberships — invisible in `workspace list`, because it is in no workspace.
 *
 * Control-plane read (`User`, `Membership`, `Workspace`): these decide tenancy
 * rather than being scoped by it, so spanning workspaces is correct here.
 */
import { Command } from "commander";

import { onExit } from "../../runtime";

export function register(parent: Command): void {
  parent
    .command("list")
    .description("Every account, its workspaces, and whether it has a second factor")
    .addHelpText(
      "after",
      `
Flags the accounts with no membership — they can sign in and land nowhere — and
the ones with no second factor enrolled.
`,
    )
    .action(run);
}

async function run() {
  const { authDb } = await import("../../../lib/server/db");
  onExit(() => authDb.$disconnect());

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
    console.log('  money user create --email <email> --name "<name>"');
    return;
  }

  for (const user of users) {
    // Enrolled, not required — REQUIRE_MFA is the flag. Shown because this list
    // has to be free of "no mfa" before that flag can be turned on.
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
