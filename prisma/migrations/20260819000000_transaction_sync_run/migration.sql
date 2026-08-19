-- Which run brought a transaction in, as a link rather than a tag.
--
-- The sync used to answer this by stamping every fresh arrival with an
-- `ingested-<date>` label. That was a per-UTC-day bucket, so two runs on one day
-- — or two bank links — shared it, and it put rows on /labels nobody made. Same
-- for the rules engine's derived `category-rule-*` tags, which named an effect
-- and accumulated across every run that ever had it. `FieldChange` gets the
-- counterpart of its existing `ruleRunId` so a transaction's history can link an
-- `akahu` edit to its run the way it already links a `rule` one.
--
-- SyncRun.id stops counting at the same time, for the reason opaque_ids gave for
-- RuleRun: `/sync/<id>` now reaches a URL, and a serial there is both enumerable
-- and a public count of every sync run on the instance. That migration re-keyed
-- its rows to `gen_random_uuid()` hex; those rows have since aged out, leaving
-- RuleRun uniformly cuid, and SyncRun keeps years of history — so a hex minority
-- here would sit beside Prisma's cuids forever. Casting the column is all that
-- happens here: minting an id the app would recognise is not something SQL can
-- do deterministically, so `money sync reindex-runs` does it, the same split
-- `unhook-bootstrap-ids` uses for the bootstrap rows.
--
-- No grant changes: DML on these tables is granted table-level to money_app and
-- money_sync (rls_backstop), which a new column inherits.

-- SyncRun.id: serial -> text. Existing rows keep their counter as text until
-- `money sync reindex-runs` retires it.
ALTER TABLE "SyncRun" DROP CONSTRAINT "SyncRun_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "SyncRun_id_seq";

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "syncRunId" TEXT;

-- AlterTable
ALTER TABLE "FieldChange" ADD COLUMN     "syncRunId" TEXT;

-- CreateIndex
CREATE INDEX "Transaction_syncRunId_idx" ON "Transaction"("syncRunId");

-- CreateIndex
CREATE INDEX "FieldChange_syncRunId_idx" ON "FieldChange"("syncRunId");

-- AddForeignKey. ON UPDATE CASCADE is what lets `reindex-runs` re-key a parent
-- and have its children follow.
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FieldChange" ADD CONSTRAINT "FieldChange_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill the links. `Transaction.syncedAt` is `@default(now())` and never
-- rewritten (the sync's upsert payload has no `syncedAt`), so it is the instant
-- of first insert: match it into each successful run's execution window. Runs
-- drain serially per workspace, so at most one window holds a given instant; the
-- ORDER BY guards against any historical overlap. Rows outside every window stay
-- null.
UPDATE "Transaction" t SET "syncRunId" = (
  SELECT r.id FROM "SyncRun" r
   WHERE r."workspaceId" = t."workspaceId"
     AND r.status = 'success'
     AND r."finishedAt" IS NOT NULL
     AND t."syncedAt" >= r."startedAt"
     AND t."syncedAt" <= r."finishedAt"
   ORDER BY r."startedAt" DESC
   LIMIT 1
);

-- The same for the sync's own log rows, keyed on when the row was written.
UPDATE "FieldChange" c SET "syncRunId" = (
  SELECT r.id FROM "SyncRun" r
   WHERE r."workspaceId" = c."workspaceId"
     AND r.status = 'success'
     AND r."finishedAt" IS NOT NULL
     AND c."createdAt" >= r."startedAt"
     AND c."createdAt" <= r."finishedAt"
   ORDER BY r."startedAt" DESC
   LIMIT 1
)
WHERE c.source = 'akahu';
