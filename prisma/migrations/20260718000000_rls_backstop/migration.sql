-- Phase 6: Row-Level Security, a defence-in-depth backstop beneath the
-- app-level scoped client (lib/server/db/scoped.ts).
--
-- App-level scoping stays the primary mechanism. This adds the one control that
-- still holds if the app layer has a bug — a forgotten `where`, a new unscoped
-- model, an injection: the database itself refuses to return another workspace's
-- rows. Policies read a per-transaction GUC (`app.workspace_id`) that the scoped
-- client sets via `set_config(..., true)` before every query. `, true`
-- (missing_ok) makes an unset var read as NULL, so an unscoped touch of a tenant
-- table matches zero rows and fails closed rather than leaking everything.
--
-- Why roles: RLS is *ignored for a table's owner*. The migration/bootstrap role
-- (the one running this) owns every table, so RLS only becomes real once the
-- app and cron connect as non-owner roles it applies to. That is also least
-- privilege — a compromised app role cannot run DDL, drop tables, or rewrite the
-- shared catalogs. RLS is deliberately NOT forced: the owner keeps bypassing it,
-- which is what lets migrations, the bootstrap script and local `next dev` keep
-- working unchanged.

-- 1. Runtime roles. Created NOLOGIN and passwordless on purpose — no credential
--    belongs in a committed migration. `scripts/db-roles.ts` (run by `pnpm
--    db:setup` and the migrate compose step) grants LOGIN + a password from env.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'money_app') THEN
    CREATE ROLE money_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'money_sync') THEN
    CREATE ROLE money_sync NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO money_app, money_sync;

-- 2. Enable RLS + the isolation policy on every tenant-owned table. `FOR ALL`
--    (the default) applies USING to SELECT/UPDATE/DELETE and WITH CHECK to
--    INSERT/UPDATE, so a write cannot land a row in another workspace either.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'BankLink','Account','Transaction','PendingTransaction','BalanceSnapshot',
    'TransferGroup','TransactionConflict','RuleDocument','RuleRun','FieldChange',
    'SyncState','SyncRun'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I'
      || ' USING ("workspaceId" = current_setting(''app.workspace_id'', true))'
      || ' WITH CHECK ("workspaceId" = current_setting(''app.workspace_id'', true))',
      t);
  END LOOP;
END $$;

-- Merchant is half shared catalog (workspaceId IS NULL, Akahu's global rows) and
-- half a workspace's own private merchants — the same split scoped.ts encodes in
-- merchantFilter/stampFor. The NULL branch in WITH CHECK is what lets the sync
-- mirror global merchants; app-level rules keep a request from minting one.
ALTER TABLE "Merchant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Merchant"
  USING ("workspaceId" IS NULL OR "workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" IS NULL OR "workspaceId" = current_setting('app.workspace_id', true));

-- 3. Privileges (least privilege on top of RLS). The runtime roles get DML on the
-- tenant tables, Merchant and the catalogs — both roles, because the app runs the
-- same ingest pipeline the cron does (the /sync "full sync" button calls runSync,
-- which mirrors categories, FX rates and connections). RLS decides which tenant
-- rows each actually sees, so a broad grant here is not a broad reach; the
-- least-privilege that matters is that neither role owns the schema (no DDL, no
-- DROP, RLS applies) and only money_app reaches the auth tables (below).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'BankLink','Account','Transaction','PendingTransaction','BalanceSnapshot',
    'TransferGroup','TransactionConflict','RuleDocument','RuleRun','FieldChange',
    'SyncState','SyncRun','Merchant',
    'Category','CategoryGroup','FxRate','Connection'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO money_app, money_sync', t);
  END LOOP;
END $$;

-- Control plane: the web app manages workspaces/memberships/invites. The sync
-- only enumerates workspaces to iterate tenants (see scripts/ingest.ts).
GRANT SELECT, INSERT, UPDATE, DELETE ON "Workspace", "Membership", "Invite" TO money_app;
GRANT SELECT ON "Workspace" TO money_sync;

-- Auth tables: only Better Auth's adapter touches them, and it runs as the app.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "User", "Session", "AuthAccount", "Verification", "TwoFactor" TO money_app;

-- Sequences behind the autoincrement PKs (PendingTransaction, TransactionConflict,
-- BalanceSnapshot, SyncRun, RuleDocument).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO money_app, money_sync;

-- 4. Future tables/sequences created by the migration role inherit these grants,
--    so a later migration doesn't silently ship a table the runtime roles cannot
--    touch. No FOR ROLE clause: it defaults to the current role, which is
--    whatever owns the schema — so this survives a renamed POSTGRES_USER. A new
--    *catalog* table would be over-granted to money_app here (INSERT/UPDATE it
--    shouldn't have); the migration that adds one should REVOKE to tighten.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO money_app, money_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO money_app, money_sync;
