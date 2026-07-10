-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "flow" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "flowSource" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "incomeCategory" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "transferId" TEXT;

-- CreateTable
CREATE TABLE "TransactionOverride" (
    "transactionId" TEXT NOT NULL PRIMARY KEY,
    "flow" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransactionOverride_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Transaction_flow_date_idx" ON "Transaction"("flow", "date");

-- CreateIndex
CREATE INDEX "Transaction_flowSource_idx" ON "Transaction"("flowSource");

-- CreateIndex
CREATE INDEX "Transaction_transferId_idx" ON "Transaction"("transferId");
