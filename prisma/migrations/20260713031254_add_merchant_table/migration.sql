-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "website" TEXT
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
CREATE INDEX "Merchant_name_idx" ON "Merchant"("name");
