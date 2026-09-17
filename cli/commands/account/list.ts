/**
 * Every account in a workspace, with the ids the other commands take.
 *
 *   money account list --workspace personal
 *
 * Exists because `money account supersede --pair` needs two `acc_...` ids and
 * there was nowhere to read them. It also shows the two columns that decide
 * whether a merge is wanted: what Akahu says this account succeeded
 * (`migrated<-`), and whether it has already been merged away (`superseded->`).
 */
import { Command } from "commander";

import { resolveWorkspace } from "../../lib/membership";
import { onExit } from "../../runtime";

type Opts = { workspace: string };

export function register(parent: Command): void {
  parent
    .command("list")
    .description("Every account in a workspace, with its id and migration state")
    .requiredOption("--workspace <slug|id>", "which workspace")
    .addHelpText(
      "after",
      `
Reads only. "migrated<-" is Akahu's own word for the account this one replaced
when its bank moved to official open banking; "superseded->" is this instance's
record that the duplication has already been resolved into that account.
`,
    )
    .action(run);
}

async function run(opts: Opts) {
  // `catalogDb` purely as a teardown handle — every client here is the same
  // connection pool, and this command reads nothing unscoped. Registered before
  // the first query so a thrown lookup still closes the pool.
  const { catalogDb, scopedDb } = await import("../../../lib/server/db");
  onExit(() => catalogDb.$disconnect());

  const workspace = await resolveWorkspace(opts.workspace);
  const db = scopedDb(workspace.id);

  const accounts = await db.account.findMany({
    select: {
      id: true,
      name: true,
      displayName: true,
      formattedAccount: true,
      type: true,
      status: true,
      currency: true,
      balanceCurrent: true,
      migratedFromId: true,
      supersededById: true,
      connection: { select: { name: true, connectionType: true } },
      _count: { select: { transactions: true } },
    },
    orderBy: [{ supersededById: "asc" }, { name: "asc" }],
  });

  if (accounts.length === 0) {
    console.log(`No accounts in ${workspace.slug}. Has it ever synced?`);
    return;
  }

  for (const account of accounts) {
    const label = account.displayName ?? account.name;
    const balance = account.balanceCurrent === null ? "" : ` ${account.currency ?? ""} ${account.balanceCurrent}`;
    console.log(
      `${account.id}  ${label}` +
        `\n  ${account.connection.name} (${account.connection.connectionType})` +
        `  ${account.formattedAccount ?? "—"}  ${account.type}  [${account.status}]${balance}` +
        `  ${account._count.transactions} tx`,
    );
    if (account.migratedFromId) console.log(`  migrated<-    ${account.migratedFromId}`);
    if (account.supersededById) console.log(`  superseded->  ${account.supersededById}`);
  }
}
