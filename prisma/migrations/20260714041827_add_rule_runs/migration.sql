-- CreateTable
CREATE TABLE "RuleRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'success',
    "evaluated" INTEGER NOT NULL DEFAULT 0,
    "categorised" INTEGER NOT NULL DEFAULT 0,
    "merchantsSet" INTEGER NOT NULL DEFAULT 0,
    "transfersLinked" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT
);

-- CreateTable
CREATE TABLE "RuleApplication" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "transactionId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "fromLabel" TEXT,
    "toLabel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RuleApplication_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RuleRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RuleRun_startedAt_idx" ON "RuleRun"("startedAt");

-- CreateIndex
CREATE INDEX "RuleApplication_runId_idx" ON "RuleApplication"("runId");

-- CreateIndex
CREATE INDEX "RuleApplication_transactionId_idx" ON "RuleApplication"("transactionId");
