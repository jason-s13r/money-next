import { Command } from "commander";

import { register as create } from "./create";
import { register as remove } from "./delete";
import { register as list } from "./list";
import { register as password } from "./password";
import { register as rename } from "./rename";

/**
 * Accounts. The first one has nobody to invite it; the rest are an operator
 * acting on someone else's account without their session.
 */
export function register(program: Command): void {
  const user = program.command("user").description("Accounts: create, inspect, rename, let back in");

  create(user);
  list(user);
  rename(user);
  password(user);
  remove(user);
}
