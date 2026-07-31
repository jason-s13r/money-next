// Shared bootstrap for the CLI scripts under `scripts/`.
//
// Every script ends with the same three lines: run `main`, print the error
// message on failure, and disconnect whichever database client was opened (if
// any) in a `finally`. The `disconnect` is optional and lazily set because a
// `--help` run exits before `main` imports the database layer, and calling
// `$disconnect()` on an unbound client is the TypeError that used to make
// `pnpm link:token --help` exit 1 on the one machine most likely to run it.
//
// Usage at the bottom of a script:
//
//   runScript(main, () => disconnect?.());
//
// `main` is the async entry point; `cleanup` is the optional teardown. The
// script owns its process, so it owns the disconnect — a server action must
// never do this (see docs/multi-user.md).

export function runScript(
  main: () => Promise<unknown>,
  cleanup?: () => Promise<unknown> | unknown,
): void {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await cleanup?.();
    });
}
