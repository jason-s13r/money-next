import { Command } from "commander";

import { register as addMember } from "./add-member";
import { register as create } from "./create";
import { register as remove } from "./delete";
import { register as list } from "./list";

/**
 * Tenants. A workspace cannot be created from inside one — no `[workspace]`
 * segment to authorize against, and no site-admin role to do it instead.
 */
export function register(program: Command): void {
  const workspace = program
    .command("workspace")
    .description("Tenants: create, survey, add members, destroy");

  create(workspace);
  list(workspace);
  addMember(workspace);
  remove(workspace);
}
