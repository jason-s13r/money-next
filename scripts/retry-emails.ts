/**
 * Put failed messages back on the queue, or throw them away.
 *
 *   pnpm email:retry <id>        one message
 *   pnpm email:retry --all       every failed message
 *   pnpm email:clear-failed      delete them instead
 *
 * Both verbs act on the same rows — the ones `pnpm email:list` shows as `failed`
 * — which is why they share a file. A failed row is terminal by design: the queue
 * spends its attempts and stops rather than retrying a bad password forever. That
 * is right for the worker and wrong for the person who has since fixed the
 * password, and this is the missing half.
 *
 * Retrying resets `attempts` to zero, so a requeued message gets the full run of
 * tries again. Deliberate: the reason to run this at all is that something
 * changed, and carrying the old count over would spend the retries on the fixed
 * configuration a message at a time.
 *
 * A `reset` message older than its token is refused. The link in it is already
 * dead, and sending a dead link is worse than sending nothing — the recipient
 * clicks, gets an error, and concludes the reset is broken rather than asking for
 * another one. Invites do not have this problem: `Invitation` rows outlive the
 * message by a wide margin, and an expired one fails on the invite page with an
 * explanation.
 *
 * Control-plane write (`EmailOutbox`): no workspace column to scope by, and the
 * table holds an address, a link and prose — see scripts/list-emails.ts.
 */

// Every import here is dynamic: a file with no static import or export is not
// a module.
export {};
import { runScript } from "./_bootstrap";
import { askYesNo, promptSession } from "./read-secret";

/** Set once the database is actually imported, so `--help` never opens a client. */
let disconnect: (() => Promise<void>) | null = null;

const USAGE = `Usage:
  pnpm email:retry <id> [<id>...]   requeue named failed messages
  pnpm email:retry --all            requeue every failed message
  pnpm email:clear-failed [--yes]   delete failed messages instead

Failed messages are listed by \`pnpm email:list\`. Requeuing sends on the worker's
next tick — with the worker stopped, nothing happens.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(USAGE);
    return;
  }

  const clearing = args.includes("--clear-failed");
  const all = args.includes("--all") || clearing;
  const ids = args.filter((arg) => !arg.startsWith("--"));

  if (!all && ids.length === 0) {
    throw new Error("Name at least one message id, or pass --all. See --help.");
  }
  if (all && ids.length > 0 && !clearing) {
    throw new Error("--all takes no ids: it is every failed message or the ones you name, not both.");
  }

  const { authDb } = await import("../lib/server/db");
  disconnect = () => authDb.$disconnect();

  const failed = await authDb.emailOutbox.findMany({
    where: { status: "failed", ...(all ? {} : { id: { in: ids } }) },
    select: { id: true, kind: true, to: true, startedAt: true },
    orderBy: { startedAt: "desc" },
  });

  // Named ids that matched nothing: a typo, or a row already requeued by someone
  // else. Said out loud rather than silently skipped — the whole point of naming
  // ids is to act on those and no others.
  const missing = all ? [] : ids.filter((id) => !failed.some((row) => row.id === id));
  for (const id of missing) console.log(`${id}: no failed message with that id`);

  if (failed.length === 0) {
    console.log(missing.length > 0 ? "Nothing to do." : "No failed messages.");
    return;
  }

  if (clearing) {
    for (const row of failed) console.log(`${row.kind.padEnd(7)} ${row.to}  (${row.id})`);
    console.log();

    // A `[y/N]` rather than the typed-name confirmation the workspace and user
    // deletes use: those destroy data with no other copy, this discards a record
    // of messages that were already not delivered. `--yes` skips it, because
    // `promptSession` refuses a non-terminal outright and this is the one script
    // here somebody might reasonably want on a timer.
    const go =
      args.includes("--yes") ||
      (await promptSession((io) =>
        askYesNo(io, `Delete ${failed.length} failed message${failed.length === 1 ? "" : "s"}?`),
      ));
    if (!go) {
      console.log("Nothing deleted.");
      return;
    }

    const gone = await authDb.emailOutbox.deleteMany({ where: { id: { in: failed.map((row) => row.id) } } });
    console.log(`Deleted ${gone.count}.`);
    return;
  }

  const { RESET_TOKEN_TTL_SECONDS } = await import("../lib/server/auth/reset-capture");
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

  // Guarded on `status`, so a row the worker somehow picked up between the read
  // above and here is left alone rather than having its attempts reset underneath
  // it. `error` is cleared: whatever it says is about the old configuration.
  const requeued = await authDb.emailOutbox.updateMany({
    where: { id: { in: sendable.map((row) => row.id) }, status: "failed" },
    data: { status: "queued", attempts: 0, nextAttemptAt: null, finishedAt: null, error: null },
  });

  for (const row of sendable) console.log(`${row.kind.padEnd(7)} ${row.to}  (${row.id})`);
  console.log(`\nRequeued ${requeued.count}. The worker sends on its next tick (pnpm worker:start).`);
}

/** Local time, seconds included: the gaps between attempts are tens of seconds. */
const when = (date: Date) => date.toLocaleString();

runScript(main, () => disconnect?.());
