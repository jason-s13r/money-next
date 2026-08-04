/**
 * What the mail queue is holding, and why anything in it failed.
 *
 *   pnpm email:list
 *
 * The outbox is the one queue with no page behind it. A sync or a rules run that
 * fails says so on /sync; a message that fails says so nowhere, because the only
 * person who would look — whoever clicked Invite — has already seen the copyable
 * link and moved on. Without this the failure is a line in the worker's log,
 * which on a running instance is a line nobody is tailing.
 *
 * The body is deliberately not printed. An unsent reset message contains a live
 * token, and this is a script whose whole purpose is to be run when something has
 * gone wrong — the moment output is most likely to be pasted somewhere. Address,
 * subject and error are enough to tell a bad password from a bad recipient.
 *
 * Control-plane read (`EmailOutbox`): the table has no workspace column, because
 * a password reset belongs to a person rather than a tenant. No financial data.
 */

// Every import here is dynamic: a file with no static import or export is not
// a module.
export {};
import { runScript } from "./_bootstrap";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm email:list [--all]

Lists queued and failed messages, newest first, with the reason each one failed.
  --all   include messages that were delivered`;

/** Local time, seconds included: the gaps between attempts are tens of seconds. */
const when = (date: Date | null) => (date ? date.toLocaleString() : "—");

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const all = process.argv.includes("--all");

  const { authDb } = await import("../lib/server/db");
  disconnect = () => authDb.$disconnect();

  const rows = await authDb.emailOutbox.findMany({
    // `running` is in the default set as well: a row stuck there is a worker that
    // died holding it, which looks like nothing at all until the reaper's window
    // elapses.
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
    if (!all) console.log("Delivered messages are hidden — pnpm email:list --all");
    return;
  }

  for (const row of rows) {
    console.log(`${row.status.padEnd(7)} ${row.kind.padEnd(7)} ${row.to}  (${row.id})`);
    console.log(`  ${row.subject}`);
    console.log(`  queued ${when(row.startedAt)}${row.finishedAt ? `, finished ${when(row.finishedAt)}` : ""}`);

    if (row.status === "queued" && row.nextAttemptAt) {
      // A queued row with a future nextAttemptAt is mid-backoff, not stuck. Worth
      // saying, because it is otherwise indistinguishable from one the worker is
      // ignoring — and "the worker is ignoring it" is the wrong thing to go and
      // debug.
      console.log(`  attempt ${row.attempts} failed; next try ${when(row.nextAttemptAt)}`);
    } else if (row.attempts > 0 && row.status !== "success") {
      console.log(`  ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`);
    }

    if (row.error) console.log(`  ${row.error}`);
    console.log();
  }

  const failed = rows.filter((row) => row.status === "failed").length;
  if (failed > 0) {
    // Said plainly because it is the part that is easy to get wrong: a failed row
    // is not retried, so whoever was waiting on that message is still waiting.
    console.log(`${failed} failed for good and will not be retried.`);
    console.log("The invite links still work and are on the members page; a reset must be asked for again.");
  }
}

runScript(main, () => disconnect?.());
