-- CreateTable
CREATE TABLE "Label" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionLabel" (
    "workspaceId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionLabel_pkey" PRIMARY KEY ("transactionId","labelId")
);

-- CreateIndex
CREATE INDEX "Label_workspaceId_idx" ON "Label"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Label_workspaceId_name_key" ON "Label"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "TransactionLabel_workspaceId_idx" ON "TransactionLabel"("workspaceId");

-- CreateIndex
CREATE INDEX "TransactionLabel_labelId_idx" ON "TransactionLabel"("labelId");

-- AddForeignKey
ALTER TABLE "Label" ADD CONSTRAINT "Label_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionLabel" ADD CONSTRAINT "TransactionLabel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionLabel" ADD CONSTRAINT "TransactionLabel_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionLabel" ADD CONSTRAINT "TransactionLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security for the two new tenant tables, same as every other
-- workspace-owned table (see 20260718000000_rls_backstop). The runtime roles
-- (money_app/money_sync) get their DML grant from that migration's ALTER DEFAULT
-- PRIVILEGES, which covers tables created later — so only the policy is added here.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Label','TransactionLabel'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I'
      || ' USING ("workspaceId" = current_setting(''app.workspace_id'', true))'
      || ' WITH CHECK ("workspaceId" = current_setting(''app.workspace_id'', true))',
      t);
  END LOOP;
END $$;
