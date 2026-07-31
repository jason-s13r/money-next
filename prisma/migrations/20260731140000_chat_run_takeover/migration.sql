-- Talking to a background run, and taking its log over afterwards.
--
-- Both nullable with no default, and both mean the same thing when null: nobody has
-- said anything to this run, and nobody has taken this log over — which is true of
-- every row that exists today. Nothing to backfill.

-- AlterTable
ALTER TABLE "BudgetInferenceRun" ADD COLUMN     "stopRequestedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN     "continuedAt" TIMESTAMPTZ(3);
