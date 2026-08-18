/**
 * Deletes a workspace and everything in it.
 *
 *   money workspace delete --workspace <slug|id>
 *
 * A real delete, not a flag. Every tenant table is a relation on `Workspace`
 * with `onDelete: Cascade` so this is one statement leaving nothing behind —
 * Akahu accreditation and the Privacy Act 2020 require deletion on request to be
 * real, so a soft delete would be the wrong shape for it.
 *
 * The slug has to be typed back, rather than a `[y/N]` answered by reflex. This
 * is the one command with no undo, and typing the name is the cheapest thing
 * that forces the operator to read which workspace they actually named.
 */
import { Command } from "commander";

import { promptSession } from "../../lib/read-secret";
import { onExit } from "../../runtime";

type Opts = { workspace: string };

export function register(parent: Command): void {
  parent
    .command("delete")
    .description("Delete a workspace and all its financial data")
    .requiredOption("--workspace <slug|id>", "the workspace to destroy")
    .addHelpText(
      "after",
      `
Permanently deletes a workspace and every row in it — accounts, transactions,
rules, bank links, memberships. Cascading and irreversible. Prompts for the
slug before doing anything.
`,
    )
    .action(run);
}

async function run(opts: Opts) {
  const { authDb, scopedDb } = await import("../../../lib/server/db");
  onExit(() => authDb.$disconnect());

  const workspace = await authDb.workspace.findFirst({
    where: { OR: [{ slug: opts.workspace }, { id: opts.workspace }] },
    select: {
      id: true,
      slug: true,
      name: true,
      members: { select: { role: true, user: { select: { email: true } } } },
    },
  });
  if (!workspace) {
    throw new Error(`No workspace with slug or id "${opts.workspace}". See: money workspace list`);
  }

  // Through a scoped client rather than an unscoped `count` with a where. Same
  // rule as everywhere, and it matters more here: a miscounted preview would
  // understate what the next prompt is about to destroy.
  const db = scopedDb(workspace.id);
  const [accounts, transactions, links, rules] = await Promise.all([
    db.account.count(),
    db.transaction.count(),
    db.bankLink.count(),
    db.ruleDocument.count(),
  ]);

  console.log(`About to permanently delete "${workspace.name}" (/w/${workspace.slug})`);
  console.log(`  ${transactions} transactions across ${accounts} accounts`);
  console.log(`  ${links} bank links, ${rules} rule documents`);
  console.log(`  ${workspace.members.length} members:`);
  for (const member of workspace.members) {
    console.log(`    ${member.role.padEnd(7)} ${member.user.email}`);
  }
  console.log();
  console.log("The accounts themselves are not deleted — only their membership here.");
  console.log();

  const typed = await promptSession((io) =>
    io.visible(`Type the slug "${workspace.slug}" to confirm: `),
  );
  if (typed.trim() !== workspace.slug) {
    console.log("Not deleted.");
    return;
  }

  // Not wrapped in a scoped transaction: `Workspace` is control plane with no
  // `workspaceId` of its own — the row being deleted is what the scope would be
  // derived from. The cascade does the rest.
  await authDb.workspace.delete({ where: { id: workspace.id } });

  console.log(`Deleted "${workspace.name}".`);
}
