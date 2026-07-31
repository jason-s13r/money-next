-- The unattended budget inference logs itself into a chat thread, instead of into a
-- file under `LLM_LOG_DIR`.
--
-- Three nullable/defaulted columns and nothing to backfill. An existing thread is not
-- a log (`unattended` false is what every one of them already was), and an existing
-- inference run has no owner and no thread — which is exactly true of it: it ran
-- before there was a thread to write, and its transcript, if it was kept at all, is
-- still the file it was written to.
--
-- `userId` on the run is `SET NULL`, like `FieldChange.userId`: deleting a person must
-- not delete the record that the run happened, only the claim about who asked for it.
-- `threadId` likewise — deleting a log you have finished reading is ordinary, and the
-- run it describes stays.

-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN     "unattended" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "BudgetInferenceRun" ADD COLUMN     "userId" TEXT,
ADD COLUMN     "threadId" TEXT;

-- CreateIndex
CREATE INDEX "BudgetInferenceRun_threadId_idx" ON "BudgetInferenceRun"("threadId");

-- CreateIndex
CREATE INDEX "BudgetInferenceRun_userId_idx" ON "BudgetInferenceRun"("userId");

-- AddForeignKey
ALTER TABLE "BudgetInferenceRun" ADD CONSTRAINT "BudgetInferenceRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetInferenceRun" ADD CONSTRAINT "BudgetInferenceRun_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
