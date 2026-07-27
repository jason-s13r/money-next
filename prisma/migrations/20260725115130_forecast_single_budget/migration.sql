/*
  Warnings:

  - You are about to drop the `ForecastScenario` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ForecastScenarioBudget` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ForecastScenario" DROP CONSTRAINT "ForecastScenario_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "ForecastScenarioBudget" DROP CONSTRAINT "ForecastScenarioBudget_budgetId_fkey";

-- DropForeignKey
ALTER TABLE "ForecastScenarioBudget" DROP CONSTRAINT "ForecastScenarioBudget_scenarioId_fkey";

-- DropForeignKey
ALTER TABLE "ForecastScenarioBudget" DROP CONSTRAINT "ForecastScenarioBudget_workspaceId_fkey";

-- DropTable
DROP TABLE "ForecastScenario";

-- DropTable
DROP TABLE "ForecastScenarioBudget";

-- CreateTable
CREATE TABLE "Forecast" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "budgetId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Forecast_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Forecast_workspaceId_idx" ON "Forecast"("workspaceId");

-- CreateIndex
CREATE INDEX "Forecast_budgetId_idx" ON "Forecast"("budgetId");

-- CreateIndex
CREATE UNIQUE INDEX "Forecast_workspaceId_slug_key" ON "Forecast"("workspaceId", "slug");

-- AddForeignKey
ALTER TABLE "Forecast" ADD CONSTRAINT "Forecast_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Forecast" ADD CONSTRAINT "Forecast_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security for the new tenant table, same as every other workspace-owned
-- table (see 20260718000000_rls_backstop). The runtime roles (money_app/money_sync)
-- get their DML grant from that migration's ALTER DEFAULT PRIVILEGES, which covers
-- tables created later — so only the policy is added here. The old ForecastScenario
-- and ForecastScenarioBudget policies went with their tables above.
--
-- A plain `workspaceId = current_setting(...)` table: nothing about a forecast is
-- ever mirrored from Akahu, so unlike Merchant it is not half a shared catalog.
ALTER TABLE "Forecast" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Forecast"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
