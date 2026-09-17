/**
 * Merge an account into the one an open-banking migration replaced it with.
 *
 *   money account supersede --workspace personal --auto                    # dry run
 *   money account supersede --workspace personal --auto --apply
 *   money account supersede --workspace personal --pair acc_old:acc_new --apply
 *   money account supersede --workspace personal --undo acc_old
 *
 * When a bank moves from a classic Akahu connection to official open banking,
 * Akahu mints a new `acc_...`, backfills the history under new `trans_...` ids,
 * and stops returning the old account. Nothing notices — `Account.id` *is* the
 * Akahu id — so the workspace ends up holding the same money twice, and every
 * balance and spend figure counts it twice with it.
 *
 * This is the command that resolves that: the user's edits move onto the
 * surviving rows, the duplicates are deleted, whatever history only the old
 * account had is moved across, and the old account is left as an empty tombstone
 * that the sync will skip from then on.
 *
 * Dry run unless `--apply`, because the delete is the one step that cannot be
 * undone. `--backup` writes the doomed rows out first; the Akahu payloads of
 * every deleted row survive in `AkahuRecord` regardless.
 */
import { Command } from "commander";
import { writeFile } from "node:fs/promises";

import { resolveWorkspace } from "../../lib/membership";
import { onExit } from "../../runtime";

type Opts = {
  workspace: string;
  auto?: boolean;
  pair?: string[];
  undo?: string;
  apply?: boolean;
  fallback: "report" | "heuristic" | "move";
  backup?: string;
};

export function register(parent: Command): void {
  parent
    .command("supersede")
    .description("Merge a migrated account's history into the account that replaced it")
    .requiredOption("--workspace <slug|id>", "which workspace")
    .option("--auto", "take every pair Akahu itself reports (its `_migrated` field)")
    .option(
      "--pair <old:new>",
      "one explicit pair; repeatable",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--undo <accountId>", "clear a supersession marker (does NOT un-merge)")
    .option("--apply", "actually do it — without this, nothing is written")
    .option(
      "--fallback <mode>",
      "report | heuristic | move: what to do with overlap rows Akahu did not pair",
      "report",
    )
    .option("--backup <path>", "write every row about to be deleted to this file first")
    .addHelpText(
      "after",
      `
Pairing comes from Akahu's own \`_migrated\` field, mirrored onto every row as
\`migratedFromId\`, so it is exact rather than a guess. That field only lands on
rows a sync has touched — if a pair reports no duplicates at all, the history
predates the column and wants \`money sync --full\` first.

--fallback decides the awkward case: an old row inside the new account's date
range that no successor claims. The default refuses to apply and lists them,
because moving one blind would put a duplicate back. "heuristic" pairs them on
amount + description within two days; "move" treats them all as history the new
account never received.

--undo only clears the marker. The merge itself is not reversible: restore from
--backup, or from the payloads kept in AkahuRecord.
`,
    )
    .action(run);
}

async function run(opts: Opts) {
  // `catalogDb` purely as a teardown handle — every client here is the same
  // connection pool, and this command reads nothing unscoped: the one
  // control-plane lookup is `resolveWorkspace`, which owns that call itself.
  const { catalogDb, scopedDb } = await import("../../../lib/server/db");
  const { applySupersession, planSupersession, proposeSupersessions } = await import(
    "../../../lib/server/accounts/supersede"
  );
  onExit(() => catalogDb.$disconnect());

  if (!["report", "heuristic", "move"].includes(opts.fallback)) {
    throw new Error(`--fallback must be report, heuristic or move (got "${opts.fallback}").`);
  }

  const workspace = await resolveWorkspace(opts.workspace);
  const db = scopedDb(workspace.id);

  if (opts.undo) {
    const { count } = await db.account.updateMany({
      where: { id: opts.undo, supersededById: { not: null } },
      data: { supersededById: null, supersededAt: null },
    });
    console.log(
      count === 0
        ? `${opts.undo} is not marked superseded — nothing to clear.`
        : `Cleared the marker on ${opts.undo}. Its transactions are still on the ` +
            "account they were merged into; this only lets it sync again.",
    );
    return;
  }

  const pairs = opts.auto
    ? await proposeSupersessions(db)
    : (opts.pair ?? []).map((raw) => {
        const [oldId, newId] = raw.split(":");
        if (!oldId || !newId) {
          throw new Error(`--pair wants old:new, got "${raw}".`);
        }
        return { oldId, newId };
      });

  if (pairs.length === 0) {
    console.log(
      opts.auto
        ? "No accounts report an Akahu migration this workspace also holds the predecessor for."
        : "Nothing to do — pass --auto or --pair <old:new>.",
    );
    return;
  }

  // Three passes on purpose: work out every merge, then write the backup, then
  // do them. A backup taken after the delete it is insurance against is not
  // insurance, and one taken per-pair would leave a half-written file if the
  // second pair threw.
  const plans = [];
  for (const { oldId, newId } of pairs) {
    const plan = await planSupersession(db, { oldId, newId, fallback: opts.fallback });
    plans.push(plan);

    const label = plan.next.displayName ?? plan.next.name;
    const migrated = plan.duplicates.filter((p) => p.via === "migrated").length;
    const guessed = plan.duplicates.length - migrated;

    console.log(`\n${label}  ${plan.next.formattedAccount ?? ""}`);
    console.log(`  ${plan.old.id}  ->  ${plan.next.id}`);
    console.log(
      `    ${plan.duplicates.length} duplicates` +
        (guessed > 0 ? `  (${migrated} by Akahu id, ${guessed} by shape)` : "  (by Akahu id)"),
    );

    const carried = plan.duplicates.reduce<Record<string, number>>((acc, pair) => {
      for (const change of pair.changes) acc[change.field] = (acc[change.field] ?? 0) + 1;
      return acc;
    }, {});
    const carriedText = Object.entries(carried)
      .map(([field, n]) => `${n} ${field}`)
      .join(", ");
    console.log(`    carry over: ${carriedText || "nothing — the new rows already have it"}`);
    console.log(`    ${plan.moves.length} old-only, moved to the survivor`);

    if (plan.unclaimed.length > 0) {
      console.log(`    ${plan.unclaimed.length} UNCLAIMED in the overlap:`);
      for (const row of plan.unclaimed.slice(0, 10)) {
        console.log(
          `      ${row.date.toISOString().slice(0, 10)}  ${String(row.amount).padStart(10)}  ${row.description}`,
        );
      }
      if (plan.unclaimed.length > 10) {
        console.log(`      ... and ${plan.unclaimed.length - 10} more`);
      }
    }

    // The signature of a workspace whose history predates the column: Akahu
    // named a predecessor account, but not one of its rows. Worth saying,
    // because "0 duplicates" otherwise reads as "already clean".
    if (plan.duplicates.length === 0 && plan.moves.length > 0) {
      console.log(
        "    No row on the new account names a predecessor. If this bank really did\n" +
          "    migrate, these rows were ingested before migratedFromId existed:\n" +
          `      money sync --workspace ${workspace.slug} --full --drain`,
      );
    }

  }

  if (!opts.apply) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }

  if (opts.backup) {
    const backup = [];
    for (const plan of plans) {
      backup.push({
        oldAccount: plan.old,
        newAccount: plan.next,
        transactions: await db.transaction.findMany({
          where: { id: { in: plan.duplicates.map((p) => p.old.id) } },
          include: { labels: true, conflicts: true },
        }),
      });
    }
    await writeFile(opts.backup, JSON.stringify(backup, null, 2));
    console.log(`\nBackup of ${backup.length} pair(s) written to ${opts.backup}`);
  }

  for (const plan of plans) {
    const result = await applySupersession(db, plan);
    console.log(
      `${plan.old.id} -> ${plan.next.id}: ${result.duplicatesRemoved} removed, ` +
        `${result.transactionsMoved} moved, ${result.enrichmentCarried} enriched, ` +
        `${result.labelsCarried} labels, ${result.conflictsCarried} conflicts, ` +
        `${result.changesRepointed} log rows, ${result.snapshotsMoved} snapshots, ` +
        `${result.transferGroupsPruned} empty transfers pruned`,
    );
  }
}
