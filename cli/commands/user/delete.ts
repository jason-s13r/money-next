/**
 * Deletes a user account.
 *
 *   money user delete --email <email>
 *
 * The only way an account leaves this instance: the app can remove someone from
 * a *workspace*, but an account is not a tenant's to destroy and there is no
 * site-admin surface.
 *
 * Memberships, sessions and credentials cascade. `FieldChange.userId` is
 * `onDelete: SetNull`, uniquely and deliberately — deleting a person must not
 * delete the record that an edit happened, only the claim about who made it.
 *
 * Refused if they are the only owner of a workspace. Better Auth enforces that
 * for `leave` and `update-member-role`, but there is no endpoint for deleting a
 * *user*, so nothing else watches this door — and going through it leaves a
 * workspace with financial data, live bank links still syncing, and nobody who
 * can reach it. The fix is named rather than automated: silently promoting
 * somebody, or silently deleting a household's ledger, are both worse than
 * stopping.
 */
import { Command } from "commander";

import { normalizedEmail } from "../../lib/options";
import { promptSession } from "../../lib/read-secret";
import { onExit } from "../../runtime";

type Opts = { email: string };

export function register(parent: Command): void {
  parent
    .command("delete")
    .description("Delete an account (not the workspaces it owns)")
    .requiredOption("--email <email>", "the account to delete", normalizedEmail)
    .addHelpText(
      "after",
      `
Permanently deletes an account, its memberships and its sessions. Refused if
they are the only owner of a workspace — transfer ownership at
/w/<slug>/members first, or delete the workspace. Prompts before acting.
`,
    )
    .action(run);
}

async function run(opts: Opts) {
  const { authDb } = await import("../../../lib/server/db");
  onExit(() => authDb.$disconnect());

  const user = await authDb.user.findUnique({
    where: { email: opts.email },
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
  if (!user) throw new Error(`No user with ${opts.email}. See: money user list`);

  // One query for every workspace they own, not one per membership — asking in
  // a loop is how a guard like this gets slow and then gets dropped.
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
          sole.map((m) => `  money workspace delete --workspace ${m.workspace.slug}`).join("\n"),
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
