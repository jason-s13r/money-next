-- Generalise RuleApplication into an append-only field change log.
--
-- RuleApplication was already the change log for one writer: which field a rule
-- set on which transaction, from what to what, under which run. The other two
-- writers — the Akahu sync and a person using the app — recorded nothing, so
-- "who set this category?" could only be answered for rules, and only until the
-- next writer overwrote the field.
--
-- FieldChange is that same table with `source` (akahu | user | rule) and an
-- optional actor, which makes it answer for all three. The alternative was an
-- `updatedByUserId` column per attributable field, which holds only the most
-- recent writer and forgets everything before it. See docs/multi-user.md.
--
-- Three halves, and the middle one is the one Prisma's diff does not write:
--
--   1. Create FieldChange.
--
--   2. Carry the 108 RuleApplication rows into it. Prisma's own diff drops the
--      table *before* creating the new one and moves no data — it cannot know
--      the two are related. Left as generated, this migration would silently
--      throw away every rule's history.
--
--      These rows migrate honestly, which is why they migrate at all: each one
--      already carries its real `createdAt`, its real `runId`, and the labels of
--      the actual change. Only `source` is new, and it is `rule` for all of them
--      by construction — a RuleApplication row could not have been written by
--      anything else. The ids are cuids already, so they carry across unchanged
--      and `/rules/runs/<id>` keeps linking to the same rows.
--
--      Nothing else is backfilled, deliberately. 910 transactions carry
--      `categorySource = 'user'` and 383 carry `merchantSource = 'user'`, so we
--      know a person owns those fields — but not when, and not who. A genesis
--      row would have to invent a timestamp, and inventing it is worse than the
--      log starting empty: `syncedAt` and the `source` columns already say what
--      is true about pre-log rows. The log records what it saw, from here on.
--
--   3. Drop RuleApplication.

-- 1. Create FieldChange.
CREATE TABLE "FieldChange" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actorUserId" TEXT,
    "ruleRunId" TEXT,
    "fromId" TEXT,
    "fromLabel" TEXT,
    "toId" TEXT,
    "toLabel" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FieldChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FieldChange_workspaceId_transactionId_createdAt_idx" ON "FieldChange"("workspaceId", "transactionId", "createdAt");
CREATE INDEX "FieldChange_ruleRunId_idx" ON "FieldChange"("ruleRunId");
CREATE INDEX "FieldChange_transactionId_idx" ON "FieldChange"("transactionId");

ALTER TABLE "FieldChange" ADD CONSTRAINT "FieldChange_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FieldChange" ADD CONSTRAINT "FieldChange_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FieldChange" ADD CONSTRAINT "FieldChange_ruleRunId_fkey" FOREIGN KEY ("ruleRunId") REFERENCES "RuleRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Carry the rule history across. `fromId`/`toId` stay null: RuleApplication
--    stored labels only, and there is no honest way to recover the ids it never
--    held. A null id with a label present reads as "changed to this, and the log
--    predates ids being recorded", which is exactly what happened.
INSERT INTO "FieldChange" (
    "id", "workspaceId", "transactionId", "field", "source",
    "actorUserId", "ruleRunId", "fromId", "fromLabel", "toId", "toLabel", "createdAt"
)
SELECT
    "id",
    "workspaceId",
    "transactionId",
    "field",
    'rule',
    NULL,
    "runId",
    NULL,
    "fromLabel",
    NULL,
    "toLabel",
    "createdAt"
FROM "RuleApplication";

-- 3. Drop RuleApplication.
ALTER TABLE "RuleApplication" DROP CONSTRAINT "RuleApplication_runId_fkey";
ALTER TABLE "RuleApplication" DROP CONSTRAINT "RuleApplication_workspaceId_fkey";
DROP TABLE "RuleApplication";
