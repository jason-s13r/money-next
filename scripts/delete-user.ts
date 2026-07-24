/**
 * Deletes a user account.
 *
 *   pnpm user:delete --email <email>
 *
 * The counterpart to `user:create`, and the only way an account leaves this
 * instance: the app can remove someone from a *workspace* (`/w/<slug>/members`)
 * but nothing in it deletes the person, because there is no site-admin surface
 * and an account is not a tenant's to destroy.
 *
 * What goes with them, and what does not:
 *
 *   - memberships, sessions and credentials cascade — the account stops existing
 *     and every device signed in as it is signed out.
 *   - `FieldChange.userId` is `onDelete: SetNull`, deliberately and uniquely:
 *     deleting a person must not delete the record that an edit happened, only
 *     the claim about who made it. The workspace's history stays intact and
 *     loses an attribution.
 *
 * ## The sole-owner guard
 *
 * Refused if the account is the only owner of any workspace. Better Auth enforces
 * that invariant for `leave` and `update-member-role`, but there is no endpoint
 * for deleting a *user*, so nothing else is watching this door — and going
 * through it leaves a workspace with financial data, live bank links that keep
 * syncing on the cron, and nobody who can sign in and reach it. `workspace:list`
 * prints exactly that state, which is how it was noticed.
 *
 * The fix is named rather than automated: transfer ownership in the app, or
 * delete the workspace. Silently promoting somebody, or silently deleting a
 * household's ledger because one person's account was being tidied up, are both
 * worse than stopping.
 */
import { promptSession } from "./read-secret";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm user:delete --email <email>

Permanently deletes an account, its memberships and its sessions. Refused if
they are the only owner of a workspace — transfer ownership at
/w/<slug>/members first, or delete the workspace. Prompts before acting.`;

function parseArgs(argv: string[]): { email: string } {
  const i = argv.indexOf("--email");
  const email = i === -1 ? undefined : argv[i + 1];
  if (!email) throw new Error(USAGE);
  return { email };
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
    select: {
      id: true,
      name: true,
      email: true,
      memberships: {
        select: { role: true, workspace: { select: { id: true, slug: true, name: true } } },
      },
      _count: { select: { sessions: true, fieldChanges: true } },
    },
  });
  if (!user) throw new Error(`No user with ${args.email}. See: pnpm user:list`);

  // One query for every workspace they own, rather than one per membership:
  // "how many owners does this workspace have" is the question, and asking it
  // in a loop is how a check like this gets quietly slow and then quietly
  // dropped.
  const owned = user.memberships.filter((m) => m.role === "owner");
  if (owned.length > 0) {
    const ownerCounts = await authDb.membership.groupBy({
      by: ["workspaceId"],
      where: { workspaceId: { in: owned.map((m) => m.workspace.id) }, role: "owner" },
      _count: { _all: true },
    });

    const sole = owned.filter(
      (m) => ownerCounts.find((c) => c.workspaceId === m.workspace.id)?._count._all === 1,
    );

    if (sole.length > 0) {
      throw new Error(
        `${user.email} is the only owner of ${sole.map((m) => `"${m.workspace.name}"`).join(", ")}.\n` +
          "Deleting them would leave those workspaces with data nobody can reach.\n" +
          "Make someone else an owner first:\n" +
          sole.map((m) => `  /w/${m.workspace.slug}/members`).join("\n") +
          "\nOr delete the workspace:\n" +
          sole.map((m) => `  pnpm workspace:delete --workspace ${m.workspace.slug}`).join("\n"),
      );
    }
  }

  console.log(`About to permanently delete ${user.name} <${user.email}>`);
  if (user.memberships.length > 0) {
    console.log("  loses membership of:");
    for (const m of user.memberships) {
      console.log(`    ${m.role.padEnd(7)} ${m.workspace.name} (/w/${m.workspace.slug})`);
    }
  } else {
    console.log("  in no workspaces");
  }
  console.log(`  ${user._count.sessions} sessions signed out`);
  console.log(
    `  ${user._count.fieldChanges} logged edits stay, and become unattributed`,
  );
  console.log();
  console.log("No workspace or financial data is deleted.");
  console.log();

  const typed = await promptSession((io) =>
    io.visible(`Type the email "${user.email}" to confirm: `),
  );
  if (typed.trim() !== user.email) {
    console.log("Not deleted.");
    return;
  }

  await authDb.user.delete({ where: { id: user.id } });

  console.log(`Deleted ${user.email}.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnect?.();
  });
