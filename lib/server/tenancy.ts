/**
 * Where the workspace comes from, until phase 3 brings auth.
 *
 * There is no session yet, so there is nothing to resolve a tenant *from*: every
 * request is the same person. Rather than leave the query layer unscoped until
 * auth lands, it is scoped now against a hardcoded workspace — so the isolation
 * work is proven against real data while there is exactly one tenant and a
 * mistake cannot leak anything.
 *
 * Phase 3 deletes `BOOTSTRAP_WORKSPACE_ID` and nothing else: `getDb()` starts
 * reading the workspace from the session instead of from here, and every call
 * site above it is already written against a scoped client.
 *
 * These ids are inserted by the `tenancy_models` migration as fixed literals
 * (not `cuid()`s) so this constant and that backfill can agree without a lookup.
 */

/** The single tenant every existing row was backfilled to. */
export const BOOTSTRAP_WORKSPACE_ID = "ws_bootstrap";

/**
 * The single Akahu connection, carrying no credentials — the tokens stay in env
 * (`AKAHU_APP_ID_TOKEN`/`AKAHU_USER_ACCESS_TOKEN`) until phase 7 makes them
 * per-link. Ingest reads this to know which link it is syncing for.
 */
export const BOOTSTRAP_BANK_LINK_ID = "link_bootstrap";
