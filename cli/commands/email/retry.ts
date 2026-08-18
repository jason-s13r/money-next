/**
 * Put failed messages back on the queue, or throw them away.
 *
 *   money email retry <id>        one message
 *   money email retry --all       every failed message
 *   money email clear-failed      delete them instead
 *
 * Both verbs act on the same rows — the ones `email list` shows as `failed` —
 * which is why they share a file. A failed row is terminal by design: the queue
 * spends its attempts and stops rather than retrying a bad password forever.
 * Right for the worker, wrong for whoever has since fixed the password.
 *
 * Retrying resets `attempts` to zero, so a requeued message gets the full run
 * again — the reason to run this at all is that something changed, and carrying
 * the old count over would spend the retries a message at a time.
 *
 * A `reset` message older than its token is refused: sending a dead link is
 * worse than sending nothing, since the recipient concludes the reset is broken
 * rather than asking for another. Invites outlive their message by a wide
 * margin, and an expired one explains itself on the invite page.
 */
import { Command } from "commander";

import { askYesNo, promptSession } from "../../lib/read-secret";
import { onExit } from "../../runtime";

export function register(parent: Command): void {
  parent
    .command("retry")
    .description("Requeue failed messages after fixing whatever broke")
    .argument("[ids...]", "message ids, as printed by `money email list`")
    .option("--all", "requeue every failed message instead of naming them")
    .addHelpText(
      "after",
      `
Requeuing resets the attempt count and sends on the worker's next tick — with
the worker stopped, nothing happens. An expired reset link is refused rather
than re-sent; ask for a new one instead.
`,
    )
    .action(retry);

  parent
    .command("clear-failed")
    .description("Delete failed messages")
    .option("--yes", "skip the confirmation, for an unattended run")
    .addHelpText(
      "after",
      `
Discards the record of messages that were already not delivered. The invite
links in them still work and are on the members page; a reset must be asked for
again either way.
`,
    )
    .action(clearFailed);
}

/**
 * The failed rows this invocation is about, oldest last. Named ids that matched
 * nothing are reported rather than skipped: the point of naming ids is to act on
 * those and no others, so a typo has to be visible.
 */
async function failedRows(ids: string[], all: boolean) {
  const { authDb } = await import("../../../lib/server/db");
  onExit(() => authDb.$disconnect());

  const failed = await authDb.emailOutbox.findMany({
    where: { status: "failed", ...(all ? {} : { id: { in: ids } }) },
    select: { id: true, kind: true, to: true, startedAt: true },
    orderBy: { startedAt: "desc" },
  });

  const missing = all ? [] : ids.filter((id) => !failed.some((row) => row.id === id));
  for (const id of missing) console.log(`${id}: no failed message with that id`);

  return { authDb, failed, missing };
}

async function retry(ids: string[], opts: { all?: boolean }) {
  if (!opts.all && ids.length === 0) {
    throw new Error("Name at least one message id, or pass --all. See --help.");
  }
  if (opts.all && ids.length > 0) {
    throw new Error("--all takes no ids: it is every failed message or the ones you name, not both.");
  }

  const { authDb, failed, missing } = await failedRows(ids, opts.all ?? false);
  if (failed.length === 0) {
    console.log(missing.length > 0 ? "Nothing to do." : "No failed messages.");
    return;
  }

  const { RESET_TOKEN_TTL_SECONDS } = await import("../../../lib/server/auth/reset-capture");
  const deadline = new Date(Date.now() - RESET_TOKEN_TTL_SECONDS * 1000);
  const sendable = failed.filter((row) => !(row.kind === "reset" && row.startedAt < deadline));

  for (const row of failed) {
    if (sendable.includes(row)) continue;
    console.log(`${row.id}: the reset link expired ${when(row.startedAt)} — ask for a new one instead`);
  }

  if (sendable.length === 0) {
    console.log("Nothing requeued.");
    return;
  }

  // Guarded on `status`, so a row the worker picked up since the read above
  // keeps its attempts. `error` is cleared: it describes the old configuration.
  const requeued = await authDb.emailOutbox.updateMany({
    where: { id: { in: sendable.map((row) => row.id) }, status: "failed" },
    data: { status: "queued", attempts: 0, nextAttemptAt: null, finishedAt: null, error: null },
  });

  for (const row of sendable) console.log(`${row.kind.padEnd(7)} ${row.to}  (${row.id})`);
  console.log(`\nRequeued ${requeued.count}. The worker sends on its next tick (pnpm worker:start).`);
}

async function clearFailed(opts: { yes?: boolean }) {
  const { authDb, failed } = await failedRows([], true);
  if (failed.length === 0) {
    console.log("No failed messages.");
    return;
  }

  for (const row of failed) console.log(`${row.kind.padEnd(7)} ${row.to}  (${row.id})`);
  console.log();

  // A `[y/N]` rather than the typed-name confirmation the deletes use: those
  // destroy data with no other copy, this discards a record of messages that
  // were already not delivered. `--yes` because `promptSession` refuses a
  // non-terminal, and this is the one command here worth putting on a timer.
  const go =
    opts.yes ||
    (await promptSession((io) =>
      askYesNo(io, `Delete ${failed.length} failed message${failed.length === 1 ? "" : "s"}?`),
    ));
  if (!go) {
    console.log("Nothing deleted.");
    return;
  }

  const gone = await authDb.emailOutbox.deleteMany({ where: { id: { in: failed.map((row) => row.id) } } });
  console.log(`Deleted ${gone.count}.`);
}

/** Local time, seconds included: the gaps between attempts are tens of seconds. */
const when = (date: Date) => date.toLocaleString();
