-- Phase 7, extended to the rules backfill: "Apply now" is now enqueued and run by
-- the money_sync worker, the same shape as a sync, instead of running the whole
-- pass over every transaction inside the request (the T14 rule-graph DoS seam).
--
-- The `status` column gains `queued` and `running` values (text column, no DB
-- enum, so no DDL) — queued → running → success | failed — matching SyncRun. Two
-- columns carry the same retry/stale-claim machinery the worker already runs for
-- syncs:
--
--   * `attempts` counts how many times the worker has claimed this run, capping
--     retries at WORKER_MAX_ATTEMPTS.
--   * `nextAttemptAt` gates a re-queued row until its backoff elapses (null = now).
--
-- No grant changes: RuleRun's DML is granted table-level to both runtime roles
-- (rls_backstop), so the new columns and the money_app INSERT of a `queued` row
-- are already covered. No backfill: existing rows are terminal and default to
-- attempts=0 / nextAttemptAt=NULL.
ALTER TABLE "RuleRun" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RuleRun" ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(3);
