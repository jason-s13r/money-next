-- Normalise category groups, drop the denormalised name columns, add the enrichment
-- foreign keys, and re-base the FX table on NZD.
--
-- Data backfill runs BEFORE the table redefines below, while the old columns
-- (`Category.groupName`, `Transaction.categoryGroup`) still exist:
--   1. Seed `CategoryGroup` from the distinct groups the catalog already recorded.
--   2. Repoint `Transaction.categoryGroupId` from the old group *name* to the real
--      group id (it previously held the useless scheme key `personal_finance`).
--   3. Null any category / group id with no row, so the new FKs hold.
-- The FX rows are EUR-based and cannot be re-based without a per-day EUR/NZD rate,
-- so they are dropped rather than copied; the next `db:sync` re-fetches the whole
-- history NZD-based (see lib/server/fx.ts).

-- CreateTable
CREATE TABLE "CategoryGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL
);

-- Backfill: one row per distinct group the catalog references (real spending
-- groups and the two invented income groups both live in Category.groupId today).
INSERT INTO "CategoryGroup" ("id", "name")
SELECT "groupId", MIN("groupName")
FROM "Category"
WHERE "groupId" IS NOT NULL AND "groupName" IS NOT NULL
GROUP BY "groupId";

-- Backfill: repoint each transaction's group id from the old group name to the
-- real CategoryGroup id (unmatched names resolve to NULL, never a dangling id).
UPDATE "Transaction"
SET "categoryGroupId" = (
    SELECT "cg"."id" FROM "CategoryGroup" "cg" WHERE "cg"."name" = "Transaction"."categoryGroup"
)
WHERE "categoryGroup" IS NOT NULL;

-- Safety: drop any leftover group id (e.g. the old `personal_finance` key, or a
-- name that matched no group) so the new categoryGroupId FK holds.
UPDATE "Transaction"
SET "categoryGroupId" = NULL
WHERE "categoryGroupId" IS NOT NULL
  AND "categoryGroupId" NOT IN (SELECT "id" FROM "CategoryGroup");

-- Safety: drop any category id with no matching Category row so the new FK holds.
UPDATE "Transaction"
SET "categoryId" = NULL
WHERE "categoryId" IS NOT NULL
  AND "categoryId" NOT IN (SELECT "id" FROM "Category");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "groupId" TEXT,
    "syncedAt" DATETIME NOT NULL,
    CONSTRAINT "Category_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CategoryGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Category" ("direction", "groupId", "id", "name", "syncedAt") SELECT "direction", "groupId", "id", "name", "syncedAt" FROM "Category";
DROP TABLE "Category";
ALTER TABLE "new_Category" RENAME TO "Category";
CREATE INDEX "Category_groupId_idx" ON "Category"("groupId");
CREATE TABLE "new_FxRate" (
    "date" DATETIME NOT NULL,
    "base" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" REAL NOT NULL,

    PRIMARY KEY ("date", "base", "currency")
);
-- EUR-based rows are intentionally not copied; the next sync re-fetches NZD-based.
DROP TABLE "FxRate";
ALTER TABLE "new_FxRate" RENAME TO "FxRate";
CREATE INDEX "FxRate_base_currency_date_idx" ON "FxRate"("base", "currency", "date");
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
    "categoryId" TEXT,
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
    CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_categoryGroupId_fkey" FOREIGN KEY ("categoryGroupId") REFERENCES "CategoryGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_transferGroupId_fkey" FOREIGN KEY ("transferGroupId") REFERENCES "TransferGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" ("accountId", "amount", "balance", "cardSuffix", "categoryGroupId", "categoryId", "categorySource", "code", "connectionId", "conversionAmount", "conversionCurrency", "conversionRate", "createdAt", "date", "description", "hash", "id", "logo", "merchantId", "merchantSource", "otherAccount", "particulars", "reference", "syncedAt", "transferGroupId", "type", "updatedAt") SELECT "accountId", "amount", "balance", "cardSuffix", "categoryGroupId", "categoryId", "categorySource", "code", "connectionId", "conversionAmount", "conversionCurrency", "conversionRate", "createdAt", "date", "description", "hash", "id", "logo", "merchantId", "merchantSource", "otherAccount", "particulars", "reference", "syncedAt", "transferGroupId", "type", "updatedAt" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
CREATE INDEX "Transaction_accountId_date_idx" ON "Transaction"("accountId", "date");
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");
CREATE INDEX "Transaction_categoryGroupId_idx" ON "Transaction"("categoryGroupId");
CREATE INDEX "Transaction_categoryId_idx" ON "Transaction"("categoryId");
CREATE INDEX "Transaction_merchantId_idx" ON "Transaction"("merchantId");
CREATE INDEX "Transaction_transferGroupId_idx" ON "Transaction"("transferGroupId");
CREATE INDEX "Transaction_connectionId_idx" ON "Transaction"("connectionId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
