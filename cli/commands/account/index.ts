import { Command } from "commander";

import { register as list } from "./list";
import { register as supersede } from "./supersede";

/**
 * Accounts, at the level the app deliberately cannot reach.
 *
 * Everything the app does to an account is an edit to one row — a rename. What
 * lives here is the other thing: deciding that two accounts are one, and merging
 * their history accordingly. That is destructive, rare, and needs to be looked at
 * before it runs, which is a shell and a dry-run rather than a button.
 */
export function register(program: Command): void {
  const account = program
    .command("account")
    .description("Accounts: survey them, and merge one that a bank migration replaced");

  list(account);
  supersede(account);
}
