-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "migratedFromId" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMPTZ(3),
ADD COLUMN     "supersededById" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "migratedFromId" TEXT;

-- CreateTable
CREATE TABLE "AkahuRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "syncRunId" TEXT,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AkahuRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AkahuRecord_workspaceId_entityType_idx" ON "AkahuRecord"("workspaceId", "entityType");

-- CreateIndex
CREATE INDEX "AkahuRecord_syncRunId_idx" ON "AkahuRecord"("syncRunId");

-- CreateIndex
CREATE UNIQUE INDEX "AkahuRecord_entityType_entityId_key" ON "AkahuRecord"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Account_workspaceId_supersededById_idx" ON "Account"("workspaceId", "supersededById");

-- CreateIndex
CREATE INDEX "Transaction_workspaceId_migratedFromId_idx" ON "Transaction"("workspaceId", "migratedFromId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AkahuRecord" ADD CONSTRAINT "AkahuRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AkahuRecord" ADD CONSTRAINT "AkahuRecord_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The tenant policy for the new table, hand-written because Prisma does not know
-- RLS exists. `AkahuRecord` holds whole transaction payloads — the same data as
-- `Transaction` and then some — so it gets the same backstop the rest of the
-- tenant tables got in 20260718000000_rls_backstop, and `TENANT_MODELS` in
-- lib/server/db/scoped.ts gets the matching entry. Forgetting either half leaves
-- the other silently doing all the work, which is why tests/isolation.test.ts
-- asserts both.
--
-- No GRANT here: the ALTER DEFAULT PRIVILEGES at the end of that migration
-- already covers tables created later by the migration role.
ALTER TABLE "AkahuRecord" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AkahuRecord"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
