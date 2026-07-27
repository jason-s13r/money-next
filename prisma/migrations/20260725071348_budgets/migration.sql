-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "startsOn" TIMESTAMPTZ(3),
    "endsOn" TIMESTAMPTZ(3),
    "repeatsAnnually" BOOLEAN NOT NULL DEFAULT false,
    "origin" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "categoryGroupId" TEXT NOT NULL,
    "categoryId" TEXT,
    "merchantId" TEXT,
    "frequency" TEXT NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "anchorDate" TIMESTAMPTZ(3) NOT NULL,
    "inferred" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BudgetItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastScenario" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "includeIncome" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ForecastScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastScenarioBudget" (
    "workspaceId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForecastScenarioBudget_pkey" PRIMARY KEY ("scenarioId","budgetId")
);

-- CreateIndex
CREATE INDEX "Budget_workspaceId_startsOn_endsOn_idx" ON "Budget"("workspaceId", "startsOn", "endsOn");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_workspaceId_slug_key" ON "Budget"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "BudgetItem_workspaceId_idx" ON "BudgetItem"("workspaceId");

-- CreateIndex
CREATE INDEX "BudgetItem_budgetId_idx" ON "BudgetItem"("budgetId");

-- CreateIndex
CREATE INDEX "BudgetItem_categoryGroupId_idx" ON "BudgetItem"("categoryGroupId");

-- CreateIndex
CREATE INDEX "BudgetItem_categoryId_idx" ON "BudgetItem"("categoryId");

-- CreateIndex
CREATE INDEX "BudgetItem_merchantId_idx" ON "BudgetItem"("merchantId");

-- CreateIndex
CREATE INDEX "ForecastScenario_workspaceId_idx" ON "ForecastScenario"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastScenario_workspaceId_slug_key" ON "ForecastScenario"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "ForecastScenarioBudget_workspaceId_idx" ON "ForecastScenarioBudget"("workspaceId");

-- CreateIndex
CREATE INDEX "ForecastScenarioBudget_budgetId_idx" ON "ForecastScenarioBudget"("budgetId");

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetItem" ADD CONSTRAINT "BudgetItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetItem" ADD CONSTRAINT "BudgetItem_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetItem" ADD CONSTRAINT "BudgetItem_categoryGroupId_fkey" FOREIGN KEY ("categoryGroupId") REFERENCES "CategoryGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetItem" ADD CONSTRAINT "BudgetItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetItem" ADD CONSTRAINT "BudgetItem_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastScenario" ADD CONSTRAINT "ForecastScenario_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastScenarioBudget" ADD CONSTRAINT "ForecastScenarioBudget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastScenarioBudget" ADD CONSTRAINT "ForecastScenarioBudget_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "ForecastScenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastScenarioBudget" ADD CONSTRAINT "ForecastScenarioBudget_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security for the four new tenant tables, same as every other
-- workspace-owned table (see 20260718000000_rls_backstop). The runtime roles
-- (money_app/money_sync) get their DML grant from that migration's ALTER DEFAULT
-- PRIVILEGES, which covers tables created later — so only the policy is added here.
--
-- All four are plain `workspaceId = current_setting(...)` tables: unlike Merchant,
-- none of them is half a shared catalog, because nothing about a budget is ever
-- mirrored from Akahu. `ForecastScenarioBudget` carries its own workspaceId for
-- exactly this statement's benefit — a policy is a predicate on a column and
-- cannot follow the join to find one.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Budget','BudgetItem','ForecastScenario','ForecastScenarioBudget'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I'
      || ' USING ("workspaceId" = current_setting(''app.workspace_id'', true))'
      || ' WITH CHECK ("workspaceId" = current_setting(''app.workspace_id'', true))',
      t);
  END LOOP;
END $$;
