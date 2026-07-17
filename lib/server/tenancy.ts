/**
 * The workspace the single-user era's data was backfilled to.
 *
 * Phase 3 said it would delete this file. It didn't, quite, and the reason is
 * worth keeping: `getDb()` no longer reads these — it resolves the workspace
 * from the request and proves membership, exactly as promised — but two things
 * outside a request still need to name *the* workspace by id, because the Akahu
 * token in env belongs to precisely one tenant:
 *
 *   - `scripts/create-user.ts --owner`, which has no session to resolve from and
 *     must hand the first account ownership of something.
 *   - the bootstrap `BankLink`, which is where that env token is bound.
 *
 * So these are no longer "where the workspace comes from" — nothing routes
 * through them any more. They are the name of the default workspace, and they
 * stop being needed at all when phase 7 gives every workspace its own bank
 * connection and no workspace is default.
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
