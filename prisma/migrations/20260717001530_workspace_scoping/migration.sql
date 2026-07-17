-- Give every tenant-owned row a workspace.
--
-- Hand-written rather than generated, because the generated version cannot know
-- what to put in a NOT NULL column on 4,018 existing rows. The shape throughout
-- is: add the column with a bootstrap default, then immediately DROP DEFAULT.
--
-- Dropping the default is the point. Left in place it would be a footgun with a
-- delay on it: every future insert that forgot `workspaceId` would silently
-- succeed and land in the bootstrap workspace instead of failing. NOT NULL with
-- no default means the scoped client's stamping is load-bearing, and a mistake
-- is a loud error at the first insert rather than a quiet cross-tenant write.
--
-- There is exactly one tenant's data today, so the backfill is
-- "everything belongs to ws_bootstrap" — which is the whole reason this phase is
-- cheap now and would not be later.

-- AlterTable: Account. Also gains the link it was ingested through.
ALTER TABLE "Account" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws_bootstrap',
                      ADD COLUMN "bankLinkId" TEXT NOT NULL DEFAULT 'link_bootstrap';
ALTER TABLE "Account" ALTER COLUMN "workspaceId" DROP DEFAULT,
                      ALTER COLUMN "bankLinkId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws_bootstrap';
ALTER TABLE "Transaction" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PendingTransaction" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws_bootstrap';
ALTER TABLE "PendingTransaction" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BalanceSnapshot" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws_bootstrap';
ALTER TABLE "BalanceSnapshot" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "TransferGroup" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws_bootstrap';
ALTER TABLE "TransferGroup" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "TransactionConflict" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws_bootstrap';
ALTER TABLE "TransactionConflict" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "RuleDocument" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws_bootstrap';
ALTER TABLE "RuleDocument" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "RuleRun" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws_bootstrap';
ALTER TABLE "RuleRun" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "RuleApplication" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws_bootstrap';
ALTER TABLE "RuleApplication" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- AlterTable: SyncRun. bankLinkId stays nullable (SetNull on delete keeps the
-- audit trail when a bank is disconnected), but every existing run was this link.
ALTER TABLE "SyncRun" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws_bootstrap',
                      ADD COLUMN "bankLinkId" TEXT;
ALTER TABLE "SyncRun" ALTER COLUMN "workspaceId" DROP DEFAULT;
UPDATE "SyncRun" SET "bankLinkId" = 'link_bootstrap';

-- AlterTable: Merchant, the half-catalog table.
--
-- NULL means Akahu's global catalog, shared by everyone. Only the merchants a
-- user minted here by hand (`user_...`, see createMerchantAndSetForTransaction)
-- are tenant data — a name someone typed — so only those get stamped. Getting
-- this backwards would either leak private merchant names into every future
-- workspace's picker, or hide the entire Akahu catalog from everyone.
ALTER TABLE "Merchant" ADD COLUMN "workspaceId" TEXT;
UPDATE "Merchant" SET "workspaceId" = 'ws_bootstrap' WHERE "id" LIKE 'user\_%';

-- AlterTable: SyncState stops being a singleton.
--
-- Re-keyed from the literal id 'singleton' to the link the high-water mark
-- actually belongs to. `lastTransactionDate` is the data here and is preserved:
-- this alters the row in place rather than dropping and recreating the table.
-- Losing it would not error — it would silently re-fetch the entire transaction
-- history from Akahu on the next sync.
ALTER TABLE "SyncState" DROP CONSTRAINT "SyncState_pkey";
ALTER TABLE "SyncState" ADD COLUMN "bankLinkId" TEXT NOT NULL DEFAULT 'link_bootstrap',
                        ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws_bootstrap';
ALTER TABLE "SyncState" DROP COLUMN "id";
ALTER TABLE "SyncState" ALTER COLUMN "bankLinkId" DROP DEFAULT,
                        ALTER COLUMN "workspaceId" DROP DEFAULT;
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_pkey" PRIMARY KEY ("bankLinkId");

-- DropIndex: rule document slugs are unique per workspace, not per instance.
-- Instance-wide, the second workspace's first rule document would collide with
-- the first workspace's.
DROP INDEX "RuleDocument_slug_key";

-- CreateIndex
CREATE INDEX "Transaction_workspaceId_date_idx" ON "Transaction"("workspaceId", "date");
CREATE INDEX "PendingTransaction_workspaceId_date_idx" ON "PendingTransaction"("workspaceId", "date");
CREATE INDEX "TransferGroup_workspaceId_idx" ON "TransferGroup"("workspaceId");
CREATE INDEX "RuleDocument_workspaceId_active_idx" ON "RuleDocument"("workspaceId", "active");
CREATE UNIQUE INDEX "RuleDocument_workspaceId_slug_key" ON "RuleDocument"("workspaceId", "slug");
CREATE INDEX "RuleRun_workspaceId_startedAt_idx" ON "RuleRun"("workspaceId", "startedAt");
CREATE INDEX "SyncRun_workspaceId_startedAt_idx" ON "SyncRun"("workspaceId", "startedAt");
CREATE INDEX "SyncState_workspaceId_idx" ON "SyncState"("workspaceId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Account" ADD CONSTRAINT "Account_bankLinkId_fkey" FOREIGN KEY ("bankLinkId") REFERENCES "BankLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PendingTransaction" ADD CONSTRAINT "PendingTransaction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransferGroup" ADD CONSTRAINT "TransferGroup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransactionConflict" ADD CONSTRAINT "TransactionConflict_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BalanceSnapshot" ADD CONSTRAINT "BalanceSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_bankLinkId_fkey" FOREIGN KEY ("bankLinkId") REFERENCES "BankLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_bankLinkId_fkey" FOREIGN KEY ("bankLinkId") REFERENCES "BankLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RuleDocument" ADD CONSTRAINT "RuleDocument_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RuleRun" ADD CONSTRAINT "RuleRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RuleApplication" ADD CONSTRAINT "RuleApplication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
