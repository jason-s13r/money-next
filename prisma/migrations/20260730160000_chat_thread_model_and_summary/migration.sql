-- Per-thread model choice, and compaction.
--
-- All three are nullable with no default, and that is the whole migration story: an
-- existing thread has not chosen a model (so it uses `LLM_MODEL`, which is what it was
-- already doing) and has not been compacted (so the model still sees every message,
-- which is what it was already doing). Nothing to backfill.

-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN     "model" TEXT,
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "summarizedThroughSeq" INTEGER;
