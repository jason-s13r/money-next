import { internalDb } from "./client";

export { scopedDb, type ScopedDb } from "./scoped";

/**
 * `getDb()` — the request-scoped client — deliberately does *not* live here. It
 * is in ./request, because it needs the session and this module must not.
 *
 * The reason is `scripts/ingest.ts` (and the tests): they import `catalogDb`
 * and `scopedDb` from here and run in plain Node, outside any request. If this
 * module reached for the auth layer, the cron would need `server-only` to
 * resolve and `BETTER_AUTH_SECRET` to be set before it could sync a bank —
 * which is nonsense, and would also make the import graph circular, since the
 * auth layer needs `authDb` from here.
 *
 * So: this module is the database, and knows nothing about who is asking.
 * ./request is the database *for a request*, and is where the two meet.
 */

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

/**
 * The unscoped client, for the tenancy control plane.
 *
 * Better Auth's adapter reads and writes `User`, `Session`, `AuthAccount`,
 * `Verification`, `TwoFactor` — which have no workspace — and `Workspace`,
 * `Membership`, `Invite`, which have one but must not be filtered by it. Those
 * three are `CONTROL_PLANE_MODELS` for the reason spelled out there: they decide
 * who may enter a workspace, so the code reading them legitimately spans
 * workspaces. Redeeming an invite writes a membership for a workspace you are,
 * by definition, not yet in.
 *
 * Same client as `catalogDb`, under a second name that says why — the two uses
 * are unrelated and conflating them would make the next reader think the auth
 * tables were a shared catalog.
 *
 * This is not a general-purpose escape hatch. It is for `lib/server/auth/` and
 * the bootstrap script. Financial data goes through `getDb()` or `scopedDb(id)`.
 */
export const authDb = internalDb;
