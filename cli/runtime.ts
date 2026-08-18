/**
 * What every command needs and none of them should own: error reporting, and
 * closing whatever database client the command opened.
 */

const cleanups: (() => Promise<unknown> | unknown)[] = [];

/**
 * Register teardown for after the command finishes, however it finishes. An
 * action calls this right after importing a database client, so the disconnect
 * is registered where the client is discovered rather than declared up front.
 *
 * The process owns its clients out here, so the process disconnects them — a
 * server action must never do this (see docs/multi-user.md).
 */
export function onExit(cleanup: () => Promise<unknown> | unknown): void {
  cleanups.push(cleanup);
}

/**
 * Run the parse, report a failure the way a CLI should, and always tear down.
 *
 * `process.exitCode` rather than `process.exit()`: the cleanups still have to
 * run, and an abrupt exit would take an open connection with it.
 *
 * Commander writes and exits on `--help` and on its own parse errors, so what
 * reaches the catch is a command's own error — written for the operator, with a
 * stack that is noise.
 */
export async function run(parse: () => Promise<unknown>): Promise<void> {
  try {
    await parse();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
}
