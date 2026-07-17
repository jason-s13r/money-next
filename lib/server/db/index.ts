import { cache } from "react";

import { BOOTSTRAP_WORKSPACE_ID } from "../tenancy";
import { internalDb } from "./client";
import { scopedDb } from "./scoped";

export { scopedDb, type ScopedDb } from "./scoped";

/**
 * The workspace-scoped client for the current request.
 *
 * Memoised per request with React's `cache`, so resolving the workspace stays a
 * once-per-request job rather than a `ctx` parameter threaded through fifty
 * functions. Every query function opens with `const db = await getDb()` and is
 * otherwise unchanged.
 *
 * Phase 2 has no auth, so the workspace is the bootstrap constant. Phase 3
 * replaces the one line below with `const { workspaceId } = await requireSession()`
 * — and because every call site above already goes through a scoped client, that
 * is the whole change. The scoping work is done now, against real data, while
 * there is one tenant and a mistake cannot leak anything.
 */
export const getDb = cache(async () => {
  return scopedDb(BOOTSTRAP_WORKSPACE_ID);
});

/**
 * The unscoped client, for the paths that have no workspace to be scoped to.
 *
 * Legitimate uses are narrow and all of one kind — shared reference data that is
 * the same for everyone:
 *
 *   - the NZFCC category catalog and ECB FX rate mirrors, which run once per
 *     sync pass rather than once per workspace,
 *   - the Akahu `Connection` catalog (institution ids are global),
 *   - the throwaway SQLite importer, which predates tenancy entirely.
 *
 * If you are reaching for this to read or write a transaction, an account, or a
 * balance, it is the wrong tool and the leak is yours. Use `getDb()` in a
 * request or `scopedDb(id)` outside one.
 */
export const catalogDb = internalDb;
