/*
  Warnings:

  - You are about to drop the column `connectionName` on the `Account` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN "logo" TEXT;

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "logo" TEXT,
    "connectionType" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "formattedAccount" TEXT,
    "connectionId" TEXT NOT NULL,
    "holder" TEXT,
    "hasTransactions" BOOLEAN NOT NULL DEFAULT false,
    "canReceivePayments" BOOLEAN NOT NULL DEFAULT false,
    "canInitiatePayments" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT,
    "balanceCurrent" REAL,
    "balanceAvailable" REAL,
    "balanceLimit" REAL,
    "overdrawn" BOOLEAN,
    "refreshedBalance" DATETIME,
    "refreshedMeta" DATETIME,
    "refreshedTransactions" DATETIME,
    "refreshedParty" DATETIME,
    "refreshedAt" DATETIME,
    "syncedAt" DATETIME NOT NULL,
    CONSTRAINT "Account_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Account" ("balanceAvailable", "balanceCurrent", "balanceLimit", "connectionId", "currency", "formattedAccount", "id", "name", "overdrawn", "refreshedAt", "status", "syncedAt", "type") SELECT "balanceAvailable", "balanceCurrent", "balanceLimit", "connectionId", "currency", "formattedAccount", "id", "name", "overdrawn", "refreshedAt", "status", "syncedAt", "type" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE INDEX "Account_status_idx" ON "Account"("status");
CREATE INDEX "Account_connectionId_idx" ON "Account"("connectionId");
CREATE TABLE "new_Transaction" (
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
    "categoryGroupId" TEXT,
    "categorySource" TEXT NOT NULL DEFAULT 'akahu',
    "merchantSource" TEXT NOT NULL DEFAULT 'akahu',
    "particulars" TEXT,
    "code" TEXT,
    "reference" TEXT,
    "otherAccount" TEXT,
    "cardSuffix" TEXT,
    "conversionAmount" REAL,
    "conversionCurrency" TEXT,
    "conversionRate" REAL,
    "logo" TEXT,
    "transferGroupId" INTEGER,
    "createdAt" DATETIME,
    "updatedAt" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" ("accountId", "amount", "balance", "cardSuffix", "categoryGroup", "categoryId", "categoryName", "categorySource", "code", "connectionId", "createdAt", "date", "description", "hash", "id", "merchantId", "merchantName", "merchantSource", "otherAccount", "particulars", "reference", "syncedAt", "transferGroupId", "type", "updatedAt") SELECT "accountId", "amount", "balance", "cardSuffix", "categoryGroup", "categoryId", "categoryName", "categorySource", "code", "connectionId", "createdAt", "date", "description", "hash", "id", "merchantId", "merchantName", "merchantSource", "otherAccount", "particulars", "reference", "syncedAt", "transferGroupId", "type", "updatedAt" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
CREATE INDEX "Transaction_accountId_date_idx" ON "Transaction"("accountId", "date");
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");
CREATE INDEX "Transaction_categoryGroup_idx" ON "Transaction"("categoryGroup");
CREATE INDEX "Transaction_merchantName_idx" ON "Transaction"("merchantName");
CREATE INDEX "Transaction_merchantId_idx" ON "Transaction"("merchantId");
CREATE INDEX "Transaction_transferGroupId_idx" ON "Transaction"("transferGroupId");
CREATE INDEX "Transaction_connectionId_idx" ON "Transaction"("connectionId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Connection_connectionType_idx" ON "Connection"("connectionType");
