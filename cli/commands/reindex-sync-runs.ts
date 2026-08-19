/**
 * Retires the counter ids `SyncRun` rows carried before they reached a URL.
 *
 *   money reindex-sync-runs
 *
 * `SyncRun.id` was the last `autoincrement()` key to appear in a path
 * (`/sync/<id>`), which is the condition opaque_ids converted RuleRun for: a
 * serial there is enumerable, and it publishes how many syncs the instance has
 * ever run. The migration casts the column to text; it cannot mint the ids,
 * because a migration that generates random values is not deterministic — the
 * same split, and the same reason, as `unhook-bootstrap-ids`.
 *
 * The new ids come from Prisma itself rather than a hand-rolled generator: a
 * throwaway row is created, its id taken, and the row deleted. It is written
 * `success` and already finished, so no worker can claim it in the moment it
 * exists.
 *
 * Idempotent by construction: it acts only on ids that are still all digits, so
 * a second run finds nothing. One statement per row is enough because
 * `Transaction.syncRunId` and `FieldChange.syncRunId` are ON UPDATE CASCADE, and
 * referential-action cascades bypass RLS.
 */
import { Command } from "commander";

import type { ScopedDb } from "../../lib/server/db";
import { askYesNo, promptSession } from "../lib/read-secret";
import { onExit } from "../runtime";

/** What an un-retired id looks like: the serial, cast to text by the migration. */
const COUNTER_ID = /^[0-9]+$/;

type Opts = { yes?: boolean };

export function register(program: Command): void {
  program
    .command("reindex-sync-runs")
    .description("One-shot: give sync runs opaque ids instead of counters")
    .option("--yes", "skip the confirmation prompt, for non-interactive use")
    .addHelpText(
      "after",
      `
Sync runs predating /sync/<id> still carry the counter their serial primary key
gave them. This replaces each with a cuid from Prisma, so a run's URL stops
being guessable and stops disclosing the instance's sync count. Transactions and
change-log rows follow their run automatically.

Run once. A second run is a no-op — there is no counter left to find.
`,
    )
    .action(run);
}

/** Ask before writing, unless --yes. Fails loudly on a non-tty without --yes. */
async function confirm(yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  return promptSession((io) => askYesNo(io, question));
}

/**
 * Mint a cuid by asking the database for one, the way `unhook-bootstrap-ids`
 * mints a bank link's: Prisma generates them in its query engine and exposes no
 * function to call, so an id identical to every other run's means creating a
 * throwaway and taking its id. Terminal status, so the worker never sees it.
 */
async function mintRunCuid(db: ScopedDb): Promise<string> {
  const probe = await db.syncRun.create({
    data: { workspaceId: db.$workspaceId, status: "success", finishedAt: new Date() },
  });
  await db.syncRun.delete({ where: { id: probe.id } });
  return probe.id;
}

async function run({ yes }: Opts) {
  const { catalogDb, scopedDb } = await import("../../lib/server/db");
  onExit(() => catalogDb.$disconnect());

  const workspaces = await catalogDb.workspace.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  // Which workspaces still hold counter ids, and how many each. Counted first so
  // the prompt can say what it is about to touch.
  const pending: { id: string; name: string; runIds: string[] }[] = [];
  for (const workspace of workspaces) {
    const runs = await scopedDb(workspace.id).syncRun.findMany({
      select: { id: true },
      orderBy: { startedAt: "asc" },
    });
    const runIds = runs.map((r) => r.id).filter((id) => COUNTER_ID.test(id));
    if (runIds.length > 0) pending.push({ ...workspace, runIds });
  }

  const total = pending.reduce((n, w) => n + w.runIds.length, 0);
  if (total === 0) {
    console.log("Nothing to reindex — every sync run already has an opaque id.");
    return;
  }

  console.log(`About to reindex ${total} sync run(s):`);
  for (const w of pending) console.log(`  ${w.name}: ${w.runIds.length}`);
  console.log("  their transactions and change-log rows follow automatically");
  console.log();
  if (!(await confirm(yes ?? false, "Proceed?"))) return console.log("Unchanged.");

  for (const workspace of pending) {
    const db = scopedDb(workspace.id);
    for (const id of workspace.runIds) {
      await db.syncRun.update({ where: { id }, data: { id: await mintRunCuid(db) } });
    }
    console.log(`${workspace.name}: ${workspace.runIds.length} reindexed`);
  }

  console.log(`\nDone — ${total} sync run(s) reindexed.`);
}
