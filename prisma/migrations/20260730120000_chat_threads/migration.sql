-- CreateTable
CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "runningSince" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT,
    "toolCalls" JSONB,
    "toolCallId" TEXT,
    "toolName" TEXT,
    "elided" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatThread_workspaceId_userId_updatedAt_idx" ON "ChatThread"("workspaceId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatMessage_workspaceId_threadId_seq_idx" ON "ChatMessage"("workspaceId", "threadId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_threadId_seq_key" ON "ChatMessage"("threadId", "seq");

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security, same as every other workspace-owned table (see
-- 20260718000000_rls_backstop). The runtime roles get their DML grant from that
-- migration's ALTER DEFAULT PRIVILEGES, which covers tables created later — so only
-- the policy is added here.
--
-- Note what this policy does and does not do. It keeps another *workspace* out, which
-- is what RLS is for here: the session variable is the workspace, and there is no
-- `app.user_id` to key on. A thread being private to its *author* is enforced one
-- layer up, by the `userId` filter in lib/server/queries/chat.ts. Saying so plainly
-- because the two protections look alike from a distance and only one of them is here.
ALTER TABLE "ChatThread" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ChatThread"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

ALTER TABLE "ChatMessage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ChatMessage"
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
