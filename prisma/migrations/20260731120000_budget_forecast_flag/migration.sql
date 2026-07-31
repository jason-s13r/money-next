--
-- Replace named `Forecast` rows with a boolean `forecast` flag on `Budget`.
--
-- The dashboard and runway tiles now draw from base budgets whose `forecast` flag
-- is true, rather than from a separate `Forecast` table that pointed at a budget.
-- A budget's own name and id become the scenario name and id; its colour is
-- derived from order at read time, so deleting one does not recolour the rest.
--
-- Migration steps:
--   1. Add `forecast` to `Budget`.
--   2. Mark every budget that currently has a `Forecast` pointing at it.
--   3. Drop the `Forecast` table, its FKs, indexes, RLS policy and the relation
--      columns it added to `Budget` and `Workspace` in Prisma (the schema fields
--      are gone; the database objects follow here).

-- Add the new flag. Existing budgets are not forecasts until explicitly marked.
ALTER TABLE "Budget" ADD COLUMN "forecast" BOOLEAN NOT NULL DEFAULT false;

-- Preserve the existing dashboard lines: any budget that has a Forecast row
-- becomes a forecast budget. A budget could theoretically have several Forecast
-- rows; the boolean simply says "this budget is projected".
UPDATE "Budget"
SET "forecast" = true
WHERE "id" IN (SELECT DISTINCT "budgetId" FROM "Forecast");

-- Drop the now-redundant Forecast table and everything attached to it.
ALTER TABLE "Forecast" DROP CONSTRAINT "Forecast_workspaceId_fkey";
ALTER TABLE "Forecast" DROP CONSTRAINT "Forecast_budgetId_fkey";
DROP TABLE "Forecast";

-- The Prisma schema no longer lists the `forecasts` relation on Workspace or
-- Budget, so the implicit indexes/constraints Prisma managed for that relation
-- are gone with the table. No standalone relation columns exist to clean up.
