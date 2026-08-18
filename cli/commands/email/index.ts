import { Command } from "commander";

import { register as list } from "./list";
import { register as retry } from "./retry";

/**
 * The outbox — the one queue with no page behind it. A failed sync says so on
 * /sync; a failed message says so nowhere, because whoever clicked Invite
 * already had the copyable link and moved on.
 */
export function register(program: Command): void {
  const email = program.command("email").description("The mail queue: what is stuck, and why");

  list(email);
  retry(email);
}
