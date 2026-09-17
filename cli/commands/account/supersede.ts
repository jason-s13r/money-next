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
 * surviving rows, the duplicates Akahu itself names are deleted, and the old
 * account is left as a tombstone the sync skips from then on.
 *
 * It deletes only what Akahu calls the same row twice. Anything the migration
 * never re-issued stays on the old account and goes on counting everywhere it
 * did before — so running this is safe with a half-finished backfill, and
 * running it again later is how the rest gets cleaned up.
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
  fallback: "keep" | "heuristic" | "move" | "report";
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
      "keep | heuristic | move: what to do with rows Akahu did not pair",
      "keep",
    )
    .option("--backup <path>", "write every row about to be deleted to this file first")
    .addHelpText(
      "after",
      `
Pairing comes from Akahu's own \`_migrated\` field, mirrored onto every row as
\`migratedFromId\`, so it is exact rather than a guess. That field only lands on
rows a sync has touched — if a pair reports no duplicates at all, the history
predates the column and wants \`money sync --full\` first.

Only a paired row is deleted. Everything else stays on the old account, visible
and counting in search, spend and budgets as it always did — it is not a
duplicate of anything. Akahu backfills over days, so re-run the same pair after
a later sync and it deletes whatever has since been claimed; --auto keeps
offering a merged pair while its tombstone still holds rows.

--fallback changes that for rows nothing claimed:
  keep       (default) leave them on the old account
  heuristic  also pair rows inside the overlap on amount + description within
             two days, and delete those too — a guess, so every pair is printed
  move       move them onto the survivor, to read the history in one place

Watch the "unclaimed in the overlap" count: those sit inside the new account's
date range, so they are the ones Akahu may yet re-issue. A later re-run is what
catches it if it does.

--undo only clears the marker. The deletes are not reversible: restore from
--backup, or from the payloads kept in AkahuRecord.
`,
    )
    .action(run);
}

const day = (date: Date) => date.toISOString().slice(0, 10);

/** The first few of an awkward set, enough to recognise them by. */
function listRows(rows: { date: Date; amount: unknown; description: string }[]): void {
  for (const row of rows.slice(0, 10)) {
    console.log(`      ${day(row.date)}  ${String(row.amount).padStart(10)}  ${row.description}`);
  }
  if (rows.length > 10) {
    console.log(`      ... and ${rows.length - 10} more`);
  }
}

/** How far the successor's date moved, which is the only thing a shape pair lets vary. */
function shift(from: Date, to: Date): string {
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  return days === 0 ? "same day" : `${days > 0 ? "+" : ""}${days}d`;
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

  if (!["keep", "heuristic", "move", "report"].includes(opts.fallback)) {
    throw new Error(`--fallback must be keep, heuristic or move (got "${opts.fallback}").`);
  }
  // `report` was this mode's name while leaving a row alone also meant refusing
  // to apply. It does not any more, so the name is wrong, but an alias costs one
  // line and old muscle memory should not throw.
  const fallback = opts.fallback === "report" ? "keep" : opts.fallback;

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
        : `Cleared the marker on ${opts.undo}. Anything merged away is still on ` +
            "the account it went to; this only lets it sync again.",
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
    const plan = await planSupersession(db, { oldId, newId, fallback });
    plans.push(plan);

    const label = plan.next.displayName ?? plan.next.name;
    const migrated = plan.duplicates.filter((p) => p.via === "migrated").length;
    const guessed = plan.duplicates.length - migrated;
    // Already merged once. Worth saying, because on a re-sweep every count below
    // is about what the backfill has delivered *since* — not about the migration.
    const resweep = plan.old.supersededById === plan.next.id;

    console.log(`\n${label}  ${plan.next.formattedAccount ?? ""}`);
    console.log(
      `  ${plan.old.id}  ->  ${plan.next.id}` + (resweep ? "   (re-sweep, already merged)" : ""),
    );
    console.log(
      `    ${plan.duplicates.length} duplicates` +
        (guessed > 0 ? `  (${migrated} by Akahu id, ${guessed} by shape)` : "  (by Akahu id)"),
    );

    // A guess nobody can check is not worth making, so every shape pair is shown
    // whole: same amount and description by construction, so the dates are what
    // the match actually decided.
    const shaped = plan.duplicates.filter((p) => p.via === "heuristic");
    for (const { old, next } of shaped.slice(0, 10)) {
      const when =
        old.date.getTime() === next.date.getTime()
          ? `${day(old.date)} (same day)`
          : `${day(old.date)} -> ${day(next.date)} (${shift(old.date, next.date)})`;
      console.log(`      ${when.padEnd(32)}${String(old.amount).padStart(10)}  ${old.description}`);
    }
    if (shaped.length > 10) {
      console.log(`      ... and ${shaped.length - 10} more`);
    }

    const carried = plan.duplicates.reduce<Record<string, number>>((acc, pair) => {
      for (const change of pair.changes) acc[change.field] = (acc[change.field] ?? 0) + 1;
      return acc;
    }, {});
    const carriedText = Object.entries(carried)
      .map(([field, n]) => `${n} ${field}`)
      .join(", ");
    console.log(`    carry over: ${carriedText || "nothing — the new rows already have it"}`);

    if (plan.moves.length > 0) {
      console.log(`    ${plan.moves.length} unclaimed, moved onto the survivor`);
    } else if (plan.retained.length > 0) {
      console.log(
        `    ${plan.retained.length} unclaimed, left on ${plan.old.id} — still counted everywhere`,
      );
    }

    // The set worth reading, whichever mode put them there: outside the
    // successor's range a gap is just history the backfill never reached, but
    // inside it the backfill has a hole, and a hole can still be filled.
    if (plan.unclaimed.length > 0) {
      console.log(
        `    ${plan.unclaimed.length} of those sit inside ${plan.next.id}'s date range —\n` +
          "      re-run this pair after the next sync in case Akahu re-issues them:",
      );
      listRows(plan.unclaimed);
    }

    // The signature of a workspace whose history predates the column: Akahu
    // named a predecessor account, but not one of its rows. Worth saying,
    // because "0 duplicates" otherwise reads as "already clean".
    if (plan.duplicates.length === 0 && plan.retained.length + plan.moves.length > 0) {
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
        `${result.transactionsRetained} left in place, ${result.transactionsMoved} moved, ` +
        `${result.enrichmentCarried} enriched, ` +
        `${result.labelsCarried} labels, ${result.conflictsCarried} conflicts, ` +
        `${result.changesRepointed} log rows, ${result.snapshotsMoved} snapshots, ` +
        `${result.transferGroupsPruned} empty transfers pruned`,
    );
  }
}
