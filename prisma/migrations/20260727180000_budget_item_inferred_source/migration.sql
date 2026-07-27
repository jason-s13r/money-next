-- Records how a seeded budget item was produced: 'ai' (the local LLM) or
-- 'computed' (the deterministic fallback detector). Null for hand-typed rows.
-- Provenance for the UI's badge; distinct from `inferred`, which tracks whether a
-- row is still an untouched guess. Nullable add, no backfill: existing seeded rows
-- predate the distinction and read as null (no badge) until re-inferred.

-- AlterTable
ALTER TABLE "BudgetItem" ADD COLUMN "inferredSource" TEXT;
