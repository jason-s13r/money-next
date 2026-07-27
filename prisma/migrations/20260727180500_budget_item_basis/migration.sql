-- The seeder's one-line rationale for a figure — the LLM's ("Recurring larger
-- transactions appearing several times a year") or the deterministic detector's
-- ("12 payments over 24 months") — shown in a popover on the provenance badge.
-- Nullable, no backfill: rows seeded before this predate it and read as null.

-- AlterTable
ALTER TABLE "BudgetItem" ADD COLUMN "basis" TEXT;
