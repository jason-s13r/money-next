import { Command } from "commander";

import { register as show } from "./show";

/**
 * What Akahu actually said, as opposed to the part of it these tables keep.
 *
 * Every model here is a projection of Akahu's, and the gap between the two is
 * invisible until it costs something — `_migrated` sat unread in every payload
 * for as long as this instance had been syncing. `AkahuRecord` closes that gap
 * by keeping the payloads; this is how you look at them.
 */
export function register(program: Command): void {
  const akahu = program
    .command("akahu")
    .description("The raw Akahu payloads behind the accounts and transactions");

  show(akahu);
}
