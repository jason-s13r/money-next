-- Phase 7: close the last place the phase-6 role split stayed blunt.
--
-- The rls_backstop migration granted DML on the four shared *catalogs* to BOTH
-- runtime roles, because the /sync "full sync" button ran the whole ingest —
-- including the catalog mirroring (`syncCategories`, `syncFxRates`,
-- `syncConnections`) — inside the request, as `money_app`. That meant the web
-- role could rewrite `Category`, `CategoryGroup`, `FxRate` and `Connection`: rows
-- shared by *every* workspace, exactly the reach least-privilege wanted to deny.
--
-- Phase 7 moves that work off the request: the button now enqueues a `SyncRun`
-- (a tenant INSERT `money_app` already holds) and the `money_sync` worker does the
-- Akahu fetch and catalog mirroring. So `money_app` no longer needs to write the
-- catalogs — revoke it down to SELECT. `money_sync` keeps full DML (it runs the
-- ingest, for both the cron and the queued jobs).
REVOKE INSERT, UPDATE, DELETE ON
  "Category", "CategoryGroup", "FxRate", "Connection"
  FROM money_app;

-- Not touched: the schema-wide `ALTER DEFAULT PRIVILEGES` that grants future
-- tables' DML to money_app. Tenant tables legitimately need it (RLS decides which
-- rows money_app sees, and the web app writes its own tenant data). Catalogs are
-- the exception, and the convention the rls_backstop migration set out is exactly
-- this: "a new catalog table should REVOKE to tighten." Inverting the default so
-- money_app is SELECT-only everywhere would force every tenant table to re-grant
-- DML — more surface to get wrong, for the same end state.
