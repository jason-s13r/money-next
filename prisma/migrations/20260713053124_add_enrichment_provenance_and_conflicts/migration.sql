-- CreateTable
CREATE TABLE "TransactionConflict" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "transactionId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "userValueId" TEXT,
    "userValueLabel" TEXT,
    "akahuValueId" TEXT,
    "akahuValueLabel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TransactionConflict_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "categorySource" TEXT NOT NULL DEFAULT 'akahu',
    "merchantSource" TEXT NOT NULL DEFAULT 'akahu',
    "particulars" TEXT,
    "code" TEXT,
    "reference" TEXT,
    "otherAccount" TEXT,
    "cardSuffix" TEXT,
    "createdAt" DATETIME,
    "updatedAt" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" ("accountId", "amount", "balance", "cardSuffix", "categoryGroup", "categoryId", "categoryName", "code", "connectionId", "createdAt", "date", "description", "hash", "id", "merchantId", "merchantName", "otherAccount", "particulars", "reference", "syncedAt", "type", "updatedAt") SELECT "accountId", "amount", "balance", "cardSuffix", "categoryGroup", "categoryId", "categoryName", "code", "connectionId", "createdAt", "date", "description", "hash", "id", "merchantId", "merchantName", "otherAccount", "particulars", "reference", "syncedAt", "type", "updatedAt" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
CREATE INDEX "Transaction_accountId_date_idx" ON "Transaction"("accountId", "date");
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");
CREATE INDEX "Transaction_categoryGroup_idx" ON "Transaction"("categoryGroup");
CREATE INDEX "Transaction_merchantName_idx" ON "Transaction"("merchantName");
CREATE INDEX "Transaction_merchantId_idx" ON "Transaction"("merchantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TransactionConflict_status_idx" ON "TransactionConflict"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionConflict_transactionId_field_key" ON "TransactionConflict"("transactionId", "field");
