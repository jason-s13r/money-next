-- CreateTable
CREATE TABLE "BudgetInferenceRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "budgetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "error" TEXT,

    CONSTRAINT "BudgetInferenceRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BudgetInferenceRun_workspaceId_startedAt_idx" ON "BudgetInferenceRun"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "BudgetInferenceRun_startedAt_idx" ON "BudgetInferenceRun"("startedAt");

-- CreateIndex
CREATE INDEX "BudgetInferenceRun_budgetId_idx" ON "BudgetInferenceRun"("budgetId");

-- AddForeignKey
ALTER TABLE "BudgetInferenceRun" ADD CONSTRAINT "BudgetInferenceRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetInferenceRun" ADD CONSTRAINT "BudgetInferenceRun_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-Level Security, same as every other workspace-owned table (see
-- 20260718000000_rls_backstop). The runtime roles (money_app enqueues, money_sync
-- runs) get their DML grant from that migration's ALTER DEFAULT PRIVILEGES, which
-- covers tables created later — so only the policy is added here. A plain
-- workspaceId-scoped table: nothing about an inference run is a shared catalog.
ALTER TABLE "BudgetInferenceRun" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "BudgetInferenceRun"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
