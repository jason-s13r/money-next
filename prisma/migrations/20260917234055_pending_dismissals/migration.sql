-- CreateTable
CREATE TABLE "PendingDismissal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "tokens" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingDismissal_workspaceId_idx" ON "PendingDismissal"("workspaceId");

-- CreateIndex
CREATE INDEX "PendingDismissal_connectionId_idx" ON "PendingDismissal"("connectionId");

-- AddForeignKey
ALTER TABLE "PendingDismissal" ADD CONSTRAINT "PendingDismissal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingDismissal" ADD CONSTRAINT "PendingDismissal_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The tenant policy for the new table, hand-written because Prisma does not know
-- RLS exists — the same backstop every other tenant table got in
-- 20260718000000_rls_backstop, with the matching `TENANT_MODELS` entry in
-- lib/server/db/scoped.ts. tests/isolation.test.ts asserts both halves.
--
-- No GRANT here: the ALTER DEFAULT PRIVILEGES at the end of that migration
-- already covers tables created later by the migration role.
ALTER TABLE "PendingDismissal" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PendingDismissal"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
