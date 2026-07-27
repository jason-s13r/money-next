-- A budget is now either a base (baseBudgetId null) or a layer of exactly one
-- base. Adds the self-reference, its index, and the cascade that removes a base's
-- layers with it. No RLS block: this is the existing Budget table, already covered
-- by its tenant_isolation policy (see 20260725071348_budgets).

-- AlterTable
ALTER TABLE "Budget" ADD COLUMN "baseBudgetId" TEXT;

-- CreateIndex
CREATE INDEX "Budget_workspaceId_baseBudgetId_idx" ON "Budget"("workspaceId", "baseBudgetId");

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_baseBudgetId_fkey" FOREIGN KEY ("baseBudgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
