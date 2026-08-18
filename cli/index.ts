/**
 * The entry point bin/money runs — the one file that *executes*, kept apart so
 * that importing the command tree never parses argv or opens a connection.
 */
import { buildProgram } from "./program";
import { run } from "./runtime";

// `void`, not top-level await: no `"type": "module"`, so tsx emits CJS. `run`
// owns the rejection path anyway.
void run(() => buildProgram().parseAsync());
