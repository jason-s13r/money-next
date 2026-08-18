/**
 * What the mail queue is holding, and why anything in it failed.
 *
 *   money email list
 *
 * Without this, a failed message is a line in the worker's log, which on a
 * running instance is a line nobody is tailing.
 *
 * The body is never printed: an unsent reset carries a live token, and this is
 * run when something has gone wrong — the moment output is most likely to be
 * pasted somewhere. Address, subject and error tell a bad password from a bad
 * recipient.
 *
 * Control-plane read (`EmailOutbox`): no workspace column, because a password
 * reset belongs to a person rather than a tenant.
 */
import { Command } from "commander";

import { onExit } from "../../runtime";

type Opts = { all?: boolean };

export function register(parent: Command): void {
  parent
    .command("list")
    .description("Queued and failed messages, with the reason each one failed")
    .option("--all", "include messages that were delivered")
    .addHelpText(
      "after",
      `
Newest first. Message bodies are never printed: an unsent reset carries a live
token, and this is the command you run when something has gone wrong — the
moment output is most likely to be pasted somewhere.
`,
    )
    .action(run);
}

/** Local time, seconds included: the gaps between attempts are tens of seconds. */
const when = (date: Date | null) => (date ? date.toLocaleString() : "—");

async function run({ all }: Opts) {
  const { authDb } = await import("../../../lib/server/db");
  onExit(() => authDb.$disconnect());

  const rows = await authDb.emailOutbox.findMany({
    // `running` is in the default set too: a row stuck there is a worker that
    // died holding it, invisible until the reaper's window elapses.
    where: all ? {} : { status: { in: ["queued", "running", "failed"] } },
    select: {
      id: true,
      kind: true,
      to: true,
      subject: true,
      status: true,
      attempts: true,
      startedAt: true,
      finishedAt: true,
      nextAttemptAt: true,
      error: true,
    },
    orderBy: { startedAt: "desc" },
  });

  if (rows.length === 0) {
    console.log(all ? "The outbox is empty." : "Nothing queued or failed.");
    if (!all) console.log("Delivered messages are hidden — money email list --all");
    return;
  }

  for (const row of rows) {
    console.log(`${row.status.padEnd(7)} ${row.kind.padEnd(7)} ${row.to}  (${row.id})`);
    console.log(`  ${row.subject}`);
    console.log(`  queued ${when(row.startedAt)}${row.finishedAt ? `, finished ${when(row.finishedAt)}` : ""}`);

    if (row.status === "queued" && row.nextAttemptAt) {
      // Mid-backoff, not stuck — otherwise indistinguishable from a row the
      // worker is ignoring, which is the wrong thing to go and debug.
      console.log(`  attempt ${row.attempts} failed; next try ${when(row.nextAttemptAt)}`);
    } else if (row.attempts > 0 && row.status !== "success") {
      console.log(`  ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`);
    }

    if (row.error) console.log(`  ${row.error}`);
    console.log();
  }

  const failed = rows.filter((row) => row.status === "failed").length;
  if (failed > 0) {
    // The part easy to get wrong: a failed row is not retried, so whoever was
    // waiting on that message is still waiting.
    console.log(`${failed} failed for good and will not be retried.`);
    console.log("The invite links still work and are on the members page; a reset must be asked for again.");
  }
}
