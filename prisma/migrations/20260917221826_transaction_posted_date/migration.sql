-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "postedDate" TIMESTAMPTZ(3);

-- Backfill from the payload archive rather than from Akahu.
--
-- This is the case `AkahuRecord` was added for: `posted_date` has been in every
-- official open-banking response all along, and the column to hold it did not
-- exist until now. Without the archive this would mean another full re-sync;
-- with it, it is one statement. Instances whose archive predates this migration
-- get nothing here and fill in as syncs touch rows, which is also correct.
UPDATE "Transaction" t
SET "postedDate" = (r.payload->>'posted_date')::timestamptz
FROM "AkahuRecord" r
WHERE r."entityType" = 'transaction'
  AND r."entityId" = t.id
  AND r.payload ? 'posted_date'
  AND t."postedDate" IS NULL;
