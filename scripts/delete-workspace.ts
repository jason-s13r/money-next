/**
 * Deletes a workspace and everything in it.
 *
 *   pnpm workspace:delete --workspace <slug|id>
 *
 * This is a real delete, not a flag. Every tenant table is declared as a
 * relation on `Workspace` with `onDelete: Cascade` specifically so that this is
 * one statement and leaves nothing behind — see the comment on the model, which
 * makes the point that Akahu's accreditation and the Privacy Act 2020 require
 * deletion on request to be *real*, so a soft delete would be the wrong shape
 * for the one operation that has to be honest.
 *
 * The exception, also deliberate, is `FieldChange.userId`: `onDelete: SetNull`
 * on the user side, because deleting a person must not delete the record that an
 * edit happened, only the claim about who made it. Deleting a *workspace* takes
 * its field changes with it, since they are its rows.
 *
 * It prints what it is about to destroy and requires the slug to be typed back.
 * Not a `[y/N]`: this is the one script here with no undo, and a yes/no prompt
 * is answered by reflex. Typing the name is the cheapest thing that forces the
 * operator to read which workspace they actually named.
 */
import { promptSession } from "./read-secret";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm workspace:delete --workspace <slug|id>

Permanently deletes a workspace and every row in it — accounts, transactions,
rules, bank links, memberships. Cascading and irreversible. Prompts for the
slug before doing anything.`;

function parseArgs(argv: string[]): { workspace: string } {
  const i = argv.indexOf("--workspace");
  const workspace = i === -1 ? undefined : argv[i + 1];
  if (!workspace) throw new Error(USAGE);
  return { workspace };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const args = parseArgs(process.argv.slice(2));

  const { authDb, scopedDb } = await import("../lib/server/db");
  disconnect = () => authDb.$disconnect();

  const workspace = await authDb.workspace.findFirst({
    where: { OR: [{ slug: args.workspace }, { id: args.workspace }] },
    select: {
      id: true,
      slug: true,
      name: true,
      members: { select: { role: true, user: { select: { email: true } } } },
    },
  });
  if (!workspace) {
    throw new Error(`No workspace with slug or id "${args.workspace}". See: pnpm workspace:list`);
  }

  // Counted through a scoped client, one workspace's worth at a time, rather
  // than an unscoped `count` with a where — same rule as everywhere else, and
  // it matters more here than usual: a miscounted preview would understate what
  // the next prompt is about to destroy.
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

  // One statement; the cascade does the rest. Deliberately not wrapped in a
  // scoped transaction: `Workspace` is control plane, has no `workspaceId` of
  // its own, and is not an RLS-guarded table — the row being deleted is the
  // thing the scope would be derived from.
  await authDb.workspace.delete({ where: { id: workspace.id } });

  console.log(`Deleted "${workspace.name}".`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnect?.();
  });
