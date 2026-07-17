import "server-only";

import { cache } from "react";

import { requireWorkspace } from "../auth/session";
import { scopedDb } from "./scoped";

/**
 * The workspace-scoped client for the current request.
 *
 * Memoised per request with React's `cache`, so resolving the workspace stays a
 * once-per-request job rather than a `ctx` parameter threaded through fifty
 * functions. Every query function opens with `const db = await getDb()` and is
 * otherwise unchanged.
 *
 * Phase 3 made good on the note that used to sit on this function: the body
 * below stopped reading a hardcoded constant and started resolving the workspace
 * from the request, and — as promised — nothing above it changed. The ~132 call
 * sites were already written against a scoped client, so auth arriving was one
 * line. What the plan didn't foresee is that the line had to move house: see
 * ./index for why the database layer must not import the auth layer.
 *
 * `requireWorkspace()` is where the real work is: it resolves the `[workspace]`
 * URL segment, proves the current user is a member of it, and 404s if not. So
 * this is not merely "get a client" — it is the point every read and write in
 * the app is authorized, which is exactly where the Next.js auth guide says the
 * check belongs (close to the data, not in `proxy.ts`).
 */
export const getDb = cache(async () => {
  const { workspace } = await requireWorkspace();
  return scopedDb(workspace.id);
});
