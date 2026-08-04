-- The email outbox: the web app composes a message, the worker delivers it.
--
-- No RLS policy, because there is no `workspaceId` to write one against — a
-- password reset belongs to a person, not a workspace. This table sits with the
-- control plane in that respect.

CREATE TABLE "EmailOutbox" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "error" TEXT,

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailOutbox_status_nextAttemptAt_idx" ON "EmailOutbox"("status", "nextAttemptAt");

CREATE INDEX "EmailOutbox_startedAt_idx" ON "EmailOutbox"("startedAt");

-- Tighten `money_app` to INSERT, which is the whole point of the table.
--
-- `rls_backstop` set default privileges granting every runtime role full DML on
-- tables the migration role creates later, and said in its own comment that a
-- migration adding a table which should be narrower has to revoke. This is that
-- case, and it is not tidiness: a queued invite or reset message carries a live
-- bearer link, so SELECT here would let a compromised web role collect every
-- unredeemed one — across workspaces it is not a member of, which is reach it has
-- through no other path. UPDATE and DELETE go for the same reason (rewriting a
-- recipient is a redirect; deleting is silent suppression of an invite).
--
-- Guarded on the role existing so this migration is still applicable to a
-- database that predates the RLS roles, or a throwaway one that never made them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'money_app') THEN
    REVOKE ALL ON "EmailOutbox" FROM money_app;
    GRANT INSERT ON "EmailOutbox" TO money_app;
  END IF;
END
$$;
