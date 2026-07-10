-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "formattedAccount" TEXT,
    "connectionId" TEXT NOT NULL,
    "connectionName" TEXT NOT NULL,
    "currency" TEXT,
    "balanceCurrent" REAL,
    "balanceAvailable" REAL,
    "balanceLimit" REAL,
    "overdrawn" BOOLEAN,
    "refreshedAt" DATETIME,
    "syncedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "description" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "balance" REAL,
    "type" TEXT NOT NULL,
    "hash" TEXT,
    "merchantId" TEXT,
    "merchantName" TEXT,
    "categoryId" TEXT,
    "categoryName" TEXT,
    "categoryGroup" TEXT,
    "particulars" TEXT,
    "code" TEXT,
    "reference" TEXT,
    "otherAccount" TEXT,
    "cardSuffix" TEXT,
    "createdAt" DATETIME,
    "updatedAt" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BalanceSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountId" TEXT NOT NULL,
    "currency" TEXT,
    "current" REAL NOT NULL,
    "available" REAL,
    "limit" REAL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BalanceSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "lastTransactionDate" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'running',
    "accountsSynced" INTEGER NOT NULL DEFAULT 0,
    "transactionsSynced" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT
);

-- CreateIndex
CREATE INDEX "Account_status_idx" ON "Account"("status");

-- CreateIndex
CREATE INDEX "Transaction_accountId_date_idx" ON "Transaction"("accountId", "date");

-- CreateIndex
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");

-- CreateIndex
CREATE INDEX "Transaction_categoryGroup_idx" ON "Transaction"("categoryGroup");

-- CreateIndex
CREATE INDEX "Transaction_merchantName_idx" ON "Transaction"("merchantName");

-- CreateIndex
CREATE INDEX "BalanceSnapshot_accountId_capturedAt_idx" ON "BalanceSnapshot"("accountId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceSnapshot_accountId_capturedAt_key" ON "BalanceSnapshot"("accountId", "capturedAt");

-- CreateIndex
CREATE INDEX "SyncRun_startedAt_idx" ON "SyncRun"("startedAt");
