import { Command } from "commander";

import { register as keypair } from "./keypair";
import { register as token } from "./token";
import { register as upgrade } from "./upgrade";

/**
 * Bank links and the credentials on them. An Akahu token reads a whole bank
 * history and outlives us, so only the worker and this CLI can open one — the
 * app's connect form can seal one but never read it back.
 */
export function register(program: Command): void {
  const link = program.command("link").description("Bank links: tokens, keys, re-encryption");

  token(link);
  keypair(link);
  upgrade(link);
}
